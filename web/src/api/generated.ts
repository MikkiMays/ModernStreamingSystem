export interface paths {
    "/api/v1/attachments/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["cancel"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/attachments/{id}/content": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["download"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/capabilities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["capabilities"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/favorites": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["list"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/favorites/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["save"];
        post?: never;
        delete: operations["remove"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/favorites/{id}/join": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["join_1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["snapshot"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{id}/attachments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["files"];
        put?: never;
        post: operations["reserve"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{id}/commands": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["command"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["replay"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{id}/join": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["join"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{id}/media/screen": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["screen"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{id}/media/token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["token"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{id}/rejoin": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["rejoin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["resume"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/{roomId}/integrations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["update"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/rooms/join-by-code": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["joinCode"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Ack: {
            /** Format: uuid */
            commandId: string;
            ok: boolean;
            /** Format: int64 */
            sequence: number;
            value: string | null;
        };
        Add: {
            /** Format: uuid */
            commandId: string;
        };
        Admission: {
            credential: string;
            inviteUrl: string | null;
            participantId: string;
            /** Format: int32 */
            recoverySeconds: number;
            roomId: string;
            snapshot: components["schemas"]["Snapshot"];
        };
        Attachment: {
            /** Format: int64 */
            cancelledAt: null | number;
            /** Format: int64 */
            completedAt: null | number;
            /** Format: int64 */
            createdAt: number;
            /** Format: int64 */
            expiresAt: number;
            id: string;
            name: string;
            ownerId: string;
            roomId: string;
            sha256: string | null;
            /** Format: int64 */
            size: number;
            uploadId: string | null;
        };
        Capabilities: {
            admissionOpen: boolean;
            /** Format: int64 */
            fileMaxBytes: number;
            frameRates: number[];
            /** Format: int32 */
            maxParticipants: number;
            /** Format: int32 */
            maxScreens: number;
            /** Format: int32 */
            recoverySeconds: number;
            region: string;
            resolutions: number[];
            /** Format: int64 */
            roomMaxBytes: number;
        };
        Command: {
            /** Format: uuid */
            commandId: string;
            /** Format: int64 */
            generation?: number;
            targetId?: string;
            text?: string;
            /** @enum {string} */
            type: "leave" | "close" | "invite.create" | "invite.revoke" | "participant.remove" | "participant.approve" | "message.send" | "media.lost" | "media.restored";
        };
        Create: {
            approvalRequired?: boolean;
            /** Format: uuid */
            commandId: string;
            integrationsAllowed?: boolean;
            name: string;
            title: string;
        };
        Event: {
            eventId: string;
            /** Format: int64 */
            occurredAt: number;
            payload: components["schemas"]["EventPayload"];
            /** Format: int64 */
            sequence: number;
            /** @enum {string} */
            type: "room.changed" | "message.created" | "files.changed";
            /** Format: int32 */
            version: number;
        };
        EventPayload: {
            message: components["schemas"]["Message"] | null;
        };
        Favorite: {
            canJoin: boolean;
            closed: boolean;
            code: string;
            roomId: string;
            /** Format: int64 */
            savedAt: number;
            title: string;
        };
        Info: {
            /** Format: int64 */
            closedAt?: number;
            code?: string;
            id?: string;
            integrationsAllowed?: boolean;
            ownerPresent?: boolean;
            title?: string;
        };
        Join: {
            /** Format: uuid */
            commandId: string;
            invite: string;
            name: string;
        };
        JoinCode: {
            code: string;
            /** Format: uuid */
            commandId: string;
            name: string;
        };
        MediaToken: {
            /** Format: int64 */
            expiresAt: number;
            token: string;
            url: string;
        };
        Message: {
            /** Format: int64 */
            createdAt: number;
            /** Format: int64 */
            expiresAt: number;
            id: string;
            name: string;
            participantId: string;
            text: string;
        };
        Participant: {
            /** Format: int64 */
            generation: number;
            id: string;
            name: string;
            owner: boolean;
            /** Format: int64 */
            recoveryDeadline: null | number;
            screen: boolean;
            service: string | null;
            /** @enum {string} */
            status: "WAITING" | "JOINING" | "CONNECTED" | "RECOVERING" | "LEFT" | "EXPIRED" | "REMOVED";
        };
        Rejoin: {
            /** Format: uuid */
            commandId: string;
            name: string;
        };
        Replay: {
            events: components["schemas"]["Event"][];
            reset: boolean;
            snapshot: components["schemas"]["Snapshot"] | null;
        };
        Reserve: {
            /** Format: uuid */
            commandId: string;
            name: string;
            /** Format: int64 */
            size?: number;
        };
        Resume: {
            /** Format: int64 */
            after?: number;
        };
        Save: {
            roomCredential: string;
        };
        Screen: {
            /** Format: uuid */
            commandId: string;
            enabled?: boolean;
        };
        Settings: {
            enabled?: boolean;
        };
        Snapshot: {
            approvalRequired: boolean;
            /** Format: int64 */
            closedAt: null | number;
            code: string;
            /** Format: int64 */
            createdAt: number;
            id: string;
            integrationsAllowed: boolean;
            messages: components["schemas"]["Message"][];
            participants: components["schemas"]["Participant"][];
            /** Format: int64 */
            sequence: number;
            /** Format: int64 */
            serverTime: number;
            title: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    cancel: {
        parameters: {
            query?: never;
            header: {
                Authorization: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    download: {
        parameters: {
            query?: never;
            header: {
                Authorization: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": string;
                };
            };
        };
    };
    capabilities: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Capabilities"];
                };
            };
        };
    };
    list: {
        parameters: {
            query?: never;
            header: {
                Authorization: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Favorite"][];
                };
            };
        };
    };
    save: {
        parameters: {
            query?: never;
            header: {
                Authorization: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Save"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    remove: {
        parameters: {
            query?: never;
            header: {
                Authorization: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    join_1: {
        parameters: {
            query?: never;
            header: {
                Authorization: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Rejoin"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Admission"];
                };
            };
        };
    };
    create: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Create"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Admission"];
                };
            };
        };
    };
    snapshot: {
        parameters: {
            query?: never;
            header: {
                Authorization: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Snapshot"];
                };
            };
        };
    };
    files: {
        parameters: {
            query?: never;
            header: {
                Authorization: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Attachment"][];
                };
            };
        };
    };
    reserve: {
        parameters: {
            query?: never;
            header: {
                Authorization: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Reserve"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Attachment"];
                };
            };
        };
    };
    command: {
        parameters: {
            query?: never;
            header: {
                Authorization: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Command"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Ack"];
                };
            };
        };
    };
    replay: {
        parameters: {
            query?: {
                after?: number;
            };
            header: {
                Authorization: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Replay"];
                };
            };
        };
    };
    join: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Join"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Admission"];
                };
            };
        };
    };
    screen: {
        parameters: {
            query?: never;
            header: {
                Authorization: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Screen"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Ack"];
                };
            };
        };
    };
    token: {
        parameters: {
            query?: never;
            header: {
                Authorization: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["MediaToken"];
                };
            };
        };
    };
    rejoin: {
        parameters: {
            query?: never;
            header: {
                Authorization: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Rejoin"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Admission"];
                };
            };
        };
    };
    resume: {
        parameters: {
            query?: never;
            header: {
                Authorization: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Resume"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Replay"];
                };
            };
        };
    };
    update: {
        parameters: {
            query?: never;
            header: {
                Authorization: string;
            };
            path: {
                roomId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Settings"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Snapshot"];
                };
            };
        };
    };
    joinCode: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["JoinCode"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Admission"];
                };
            };
        };
    };
}
