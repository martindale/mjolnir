import axios from "axios";
import { HmacSHA1 } from "crypto-js";
import e from "express";
import { LogService, MatrixClient, MemoryStorageProvider, PantalaimonClient } from "matrix-bot-sdk";
import config from "../../src/config";

const REGISTRATION_ATTEMPTS = 10;
const REGISTRATION_RETRY_BASE_DELAY_MS = 100;

/**
 * Register a user using the synapse admin api that requires the use of a registration secret rather than an admin user.
 * This should only be used by test code and should not be included from any file in the source directory
 * either by explicit imports or copy pasting.
 *
 * @param username The username to give the user.
 * @param displayname The displayname to give the user.
 * @param password The password to use.
 * @param admin True to make the user an admin, false otherwise.
 * @returns The response from synapse.
 */
export async function registerUser(username: string, displayname: string, password: string, admin: boolean) {
    let registerUrl = `${config.homeserverUrl}/_synapse/admin/v1/register`
    let { data } = await axios.get(registerUrl);
    let nonce = data.nonce!;
    let mac = HmacSHA1(`${nonce}\0${username}\0${password}\0${admin ? 'admin' : 'notadmin'}`, 'REGISTRATION_SHARED_SECRET');
    for (let i = 1; i <= REGISTRATION_ATTEMPTS; ++i) {
        try {
            return await axios.post(registerUrl, {
                nonce,
                username,
                displayname,
                password,
                admin,
                mac: mac.toString()
            });
        } catch (ex) {
            // In case of timeout or throttling, backoff and retry.
            if (ex?.code === 'ESOCKETTIMEDOUT' || ex?.code === 'ETIMEDOUT'
                || ex?.response?.data?.errcode === 'M_LIMIT_EXCEEDED') {
                await new Promise(resolve => setTimeout(resolve, REGISTRATION_RETRY_BASE_DELAY_MS * i * i));
                continue;
            }
            throw ex;
        }
    }
}

export type RegistrationOptions = {
    /**
     * If specified and true, make the user an admin.
     */
    isAdmin?: boolean,
    /**
     * If `exact`, use the account with this exact name, attempting to reuse
     * an existing account if possible.
     *
     * If `contains` create a new account with a name that contains this
     * specific string.
     */
    name: { exact: string } | { contains: string },
    /**
     * If specified and true, remove throttling for this user.
     */
    isUnthrottled?: boolean
}

let globalAdminUser: MatrixClient;

/**
 * Register a new test user.
 *
 * @returns A string that is both the username and password of a new user. 
 */
async function registerNewTestUser(options: RegistrationOptions) {
    // Initialize global admin user if needed.
    if (!globalAdminUser) {
        const USERNAME = "mjolnir-test-internal-admin-user";
        try {
            await registerUser(USERNAME, USERNAME, USERNAME, true);
        } catch (e) {
            if (e.isAxiosError && e?.response?.data?.errcode === 'M_USER_IN_USE') {
                globalAdminUser = await new PantalaimonClient(config.homeserverUrl, new MemoryStorageProvider()).createClientWithCredentials(USERNAME, USERNAME);
            }
            throw e;
        }
    }

    do {
        let username;
        if ("exact" in options.name) {
            username = options.name.exact;
        } else {
            username = `mjolnir-test-user-${options.name.contains}${Math.floor(Math.random() * 100000)}`
        }
        try {
            await registerUser(username, username, username, options.isAdmin);
            return username;
        } catch (e) {
            if (e.isAxiosError && e?.response?.data?.errcode === 'M_USER_IN_USE') {
                if ("exact" in options.name) {
                    LogService.debug("test/clientHelper", `${username} already registered, reusing`);
                    return username;
                } else {
                    LogService.debug("test/clientHelper", `${username} already registered, trying another`);
                }
            } else {
                console.error(`failed to register user ${e}`);
                throw e;
            }
        }
    } while (true);
}

/**
 * Registers a test user and returns a `MatrixClient` logged in and ready to use.
 *
 * @returns A new `MatrixClient` session for a unique test user.
 */
export async function newTestUser(options: RegistrationOptions): Promise<MatrixClient> {
    const username = await registerNewTestUser(options);
    const pantalaimon = new PantalaimonClient(config.homeserverUrl, new MemoryStorageProvider());
    const client = await pantalaimon.createClientWithCredentials(username, username);
    if (options.isUnthrottled) {
        let userId = await client.getUserId();
        await globalAdminUser.doRequest("POST", `/_synapse/admin/v1/users/@${userId}/override_ratelimit`, null, {
            "messages_per_second": 0,
            "burst_count": 0
        });
    }
    return client;
}

/**
 * Utility to create an event listener for m.notice msgtype m.room.messages.
 * @param targetRoomdId The roomId to listen into.
 * @param cb The callback when a m.notice event is found in targetRoomId.
 * @returns The callback to pass to `MatrixClient.on('room.message', cb)`
 */
export function noticeListener(targetRoomdId: string, cb) {
    return (roomId, event) => {
        if (roomId !== targetRoomdId) return;
        if (event?.content?.msgtype !== "m.notice") return;
            cb(event);
    }
}
