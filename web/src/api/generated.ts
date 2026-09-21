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
    "/api/v1/ping": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["ping"];
        put?: never;
        post?: never;
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
    "/api/v1/rooms/{id}/durak-games": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["durakGames"];
        put?: never;
        post?: never;
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
    "/api/v1/rooms/{id}/games": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["games"];
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
    "/api/v1/rooms/{roomId}/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["updateRoomSettings"];
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
    "/api/v1/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["connect"];
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
        AwardView: {
            /** Format: int64 */
            amount: number;
            handCards: string[];
            handName: string;
            name: string;
            /** Format: int32 */
            seat: number;
            split: boolean;
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
            name: string;
            passwordRequired: boolean;
            /** Format: int32 */
            recoverySeconds: number;
            region: string;
            resolutions: number[];
            /** Format: int64 */
            roomMaxBytes: number;
        };
        CardPair: {
            attack: string;
            beat: string | null;
        };
        Command: {
            card?: string;
            /** Format: int64 */
            chips?: number;
            /** Format: uuid */
            commandId: string;
            contentId?: string;
            /** Format: int64 */
            generation?: number;
            kind?: string;
            option?: string;
            /** Format: int64 */
            positionMs?: number;
            provider?: string;
            /** Format: int32 */
            seat?: number;
            targetId?: string;
            text?: string;
            /** @enum {string} */
            type: "leave" | "close" | "invite.create" | "invite.revoke" | "participant.remove" | "participant.approve" | "message.send" | "media.lost" | "media.restored" | "screen.started" | "view.open" | "view.close" | "view.playing" | "microphone.mute" | "profile.avatar" | "watch.open" | "watch.play" | "watch.pause" | "watch.seek" | "watch.close" | "poker.open" | "poker.close" | "poker.sit" | "poker.stand" | "poker.deal" | "poker.next" | "poker.act" | "poker.settings" | "poker.rebuy" | "poker.reveal" | "durak.open" | "durak.close" | "durak.sit" | "durak.stand" | "durak.deal" | "durak.act" | "durak.settings";
            under?: string;
        };
        Connect: {
            password?: string;
        };
        Create: {
            approvalRequired?: boolean;
            /** Format: uuid */
            commandId: string;
            integrationsAllowed?: boolean;
            name: string;
            title: string;
        };
        DurakNote: {
            /** Format: int64 */
            at: number;
            kind: string;
            name: string;
            /** Format: int32 */
            seat: number;
            text: string;
        };
        DurakPlayer: {
            /** Format: int32 */
            bestStreak: number;
            /** Format: int32 */
            defences: number;
            /** Format: int32 */
            firsts: number;
            fool: boolean;
            /** Format: int32 */
            fools: number;
            /** Format: int32 */
            games: number;
            name: string;
            /** Format: int32 */
            place: number;
            /** Format: int32 */
            takes: number;
            /** Format: int32 */
            thrown: number;
            /** Format: int32 */
            transfers: number;
            /** Format: int32 */
            trumpsBurned: number;
        };
        DurakResult: {
            /** Format: int64 */
            at: number;
            /** Format: int32 */
            bouts: number;
            draw: boolean;
            foolName: string;
            /** Format: int32 */
            foolSeat: number;
            places: string[];
        };
        DurakScore: {
            /** Format: int32 */
            fools: number;
            /** Format: int32 */
            games: number;
            name: string;
            /** Format: int32 */
            streak: number;
        };
        DurakSeat: {
            attacker: boolean;
            away: boolean;
            defender: boolean;
            fool: boolean;
            /** Format: int32 */
            held: number;
            /** Format: int32 */
            index: number;
            memberId: string | null;
            name: string;
            out: boolean;
            passed: boolean;
            /** Format: int32 */
            place: number;
        };
        DurakSummary: {
            /** Format: int32 */
            bouts: number;
            /** Format: int32 */
            deckSize: number;
            draw: boolean;
            /** Format: int64 */
            finishedAt: number;
            foolName: string;
            highlights: components["schemas"]["Highlight"][];
            id: string;
            mode: string;
            modeName: string;
            /** Format: int32 */
            number: number;
            places: string[];
            players: components["schemas"]["DurakPlayer"][];
            /** Format: int64 */
            startedAt: number;
        };
        DurakView: {
            acting: number[];
            /** Format: int64 */
            actionAt: number;
            /** Format: int32 */
            attacker: number;
            /** Format: int64 */
            boutAt: number;
            boutEnd: string | null;
            /** Format: int64 */
            closesAt: number;
            commitment: string | null;
            /** Format: int64 */
            deadline: number;
            /** Format: int64 */
            dealtAt: number;
            /** Format: int32 */
            deckLeft: number;
            /** Format: int32 */
            deckSize: number;
            /** Format: int32 */
            defender: number;
            /** Format: int32 */
            discarded: number;
            firstFive: boolean;
            /** Format: int32 */
            handNumber: number;
            hostId: string;
            /** Format: int32 */
            limit: number;
            log: components["schemas"]["DurakNote"][];
            mode: string;
            modeName: string;
            neighbours: boolean;
            phase: string;
            result: components["schemas"]["DurakResult"] | null;
            /** Format: int64 */
            revision: number;
            score: components["schemas"]["DurakScore"][];
            seatingOpen: boolean;
            seats: components["schemas"]["DurakSeat"][];
            seed: string | null;
            table: components["schemas"]["CardPair"][];
            taking: boolean;
            transfer: boolean;
            trump: string | null;
            trumpSuit: string | null;
            /** Format: int32 */
            turnSeconds: number;
            you: components["schemas"]["DurakYou"] | null;
        };
        DurakYou: {
            actions: string[];
            cards: string[];
            /** Format: int32 */
            seat: number;
            turn: boolean;
        };
        Event: {
            eventId: string;
            /** Format: int64 */
            occurredAt: number;
            payload: components["schemas"]["EventPayload"];
            /** Format: int64 */
            sequence: number;
            /** @enum {string} */
            type: "room.changed" | "message.created" | "files.changed" | "screen.started" | "screen.first_viewer";
            /** Format: int32 */
            version: number;
        };
        EventPayload: {
            message: components["schemas"]["Message"] | null;
            participantId?: string | null;
            screenId?: string | null;
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
        GameSummary: {
            /** Format: int64 */
            bigBlind: number;
            /** Format: int64 */
            biggestPot: number;
            ending: string;
            /** Format: int64 */
            finishedAt: number;
            /** Format: int32 */
            hands: number;
            highlights: components["schemas"]["Highlight"][];
            id: string;
            /** Format: int32 */
            level: number;
            mode: string;
            modeName: string;
            players: components["schemas"]["PlayerSummary"][];
            /** Format: int64 */
            smallBlind: number;
            /** Format: int64 */
            startedAt: number;
            /** Format: int64 */
            startingStack: number;
            tournament: boolean;
        };
        Highlight: {
            hint: string;
            id: string;
            name: string;
            title: string;
            value: string;
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
        NoteView: {
            /** Format: int64 */
            amount: number;
            /** Format: int64 */
            at: number;
            kind: string;
            name: string;
            /** Format: int32 */
            seat: number;
            text: string;
        };
        Participant: {
            avatar: string;
            /** Format: int64 */
            generation: number;
            id: string;
            name: string;
            owner: boolean;
            /** Format: int64 */
            recoveryDeadline: null | number;
            screen: boolean;
            screenId?: string | null;
            screenStarted?: boolean;
            service: string | null;
            /** @enum {string} */
            status: "WAITING" | "JOINING" | "CONNECTED" | "RECOVERING" | "LEFT" | "EXPIRED" | "REMOVED";
            viewingScreenId?: string | null;
        };
        PlayerSummary: {
            /** Format: int32 */
            allIns: number;
            bestHand: string;
            /** Format: int32 */
            bestStreak: number;
            /** Format: int64 */
            biggestBet: number;
            /** Format: int64 */
            biggestPotWon: number;
            /** Format: int64 */
            buyIn: number;
            /** Format: int32 */
            calls: number;
            /** Format: int32 */
            checks: number;
            /** Format: int32 */
            folds: number;
            /** Format: int32 */
            hands: number;
            /** Format: int32 */
            handsWon: number;
            /** Format: int64 */
            invested: number;
            /** Format: int32 */
            knockouts: number;
            name: string;
            /** Format: int64 */
            net: number;
            /** Format: int64 */
            peakStack: number;
            /** Format: int32 */
            place: number;
            /** Format: int32 */
            raises: number;
            /** Format: int32 */
            rebuys: number;
            /** Format: int32 */
            showdowns: number;
            /** Format: int32 */
            showdownWins: number;
            /** Format: int64 */
            stack: number;
            /** Format: int32 */
            voluntary: number;
            /** Format: int64 */
            won: number;
        };
        PotView: {
            /** Format: int64 */
            amount: number;
            seats: number[];
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
        ResultView: {
            /** Format: int64 */
            at: number;
            awards: components["schemas"]["AwardView"][];
            busted: number[];
            drama: string;
            /** Format: int64 */
            pot: number;
            showdown: boolean;
        };
        Resume: {
            /** Format: int64 */
            after?: number;
        };
        RoomSettings: {
            approvalRequired?: boolean;
            title: string;
        };
        Save: {
            roomCredential: string;
        };
        Screen: {
            /** Format: uuid */
            commandId: string;
            enabled?: boolean;
        };
        SeatView: {
            allIn: boolean;
            away: boolean;
            /** Format: int64 */
            bet: number;
            busted: boolean;
            /** Format: int64 */
            buyIn: number;
            cards: string[];
            /** Format: int64 */
            committed: number;
            folded: boolean;
            handCards: string[];
            handName: string;
            /** Format: int32 */
            held: number;
            /** Format: int32 */
            index: number;
            inHand: boolean;
            lastAction: string;
            /** Format: int64 */
            lastActionAmount: number;
            leaving: boolean;
            memberId: string | null;
            name: string;
            /** Format: int32 */
            place: number;
            revealed: boolean;
            /** Format: int64 */
            stack: number;
            /** Format: int64 */
            timeBankMs: number;
            waiting: boolean;
            /** Format: int64 */
            wonAmount: number;
        };
        Session: {
            /** Format: int64 */
            expiresAt?: number;
            name?: string;
            passwordRequired?: boolean;
            token?: string;
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
            durak: components["schemas"]["DurakView"] | null;
            /** Format: int64 */
            durakGamesAt: number;
            id: string;
            integrationsAllowed: boolean;
            messages: components["schemas"]["Message"][];
            participants: components["schemas"]["Participant"][];
            poker: components["schemas"]["TableView"] | null;
            /** Format: int64 */
            pokerGamesAt: number;
            /** Format: int64 */
            sequence: number;
            /** Format: int64 */
            serverTime: number;
            title: string;
            watch: components["schemas"]["Watch"] | null;
        };
        TableView: {
            /** Format: int64 */
            actionAt: number;
            /** Format: int32 */
            actor: number;
            /** Format: int64 */
            ante: number;
            autoDeal: boolean;
            awaiting: boolean;
            /** Format: int64 */
            betToCall: number;
            /** Format: int64 */
            bigBlind: number;
            board: string[];
            /** Format: int32 */
            button: number;
            /** Format: int64 */
            closesAt: number;
            commitment: string;
            /** Format: int64 */
            deadline: number;
            /** Format: int32 */
            handNumber: number;
            /** Format: int64 */
            handStartedAt: number;
            hostId: string;
            /** Format: int32 */
            level: number;
            /** Format: int64 */
            levelUpAt: number;
            log: components["schemas"]["NoteView"][];
            mode: string;
            modeName: string;
            paused: boolean;
            phase: string;
            /** Format: int64 */
            pot: number;
            pots: components["schemas"]["PotView"][];
            rebuy: boolean;
            /** Format: int64 */
            rebuyChips: number;
            /** Format: int32 */
            rebuyLimit: number;
            result: components["schemas"]["ResultView"] | null;
            /** Format: int64 */
            revision: number;
            seatingOpen: boolean;
            seats: components["schemas"]["SeatView"][];
            seed: string;
            /** Format: int64 */
            smallBlind: number;
            /** Format: int64 */
            startingStack: number;
            /** Format: int64 */
            streetAt: number;
            summary: components["schemas"]["GameSummary"] | null;
            /** Format: int32 */
            turnSeconds: number;
            you: components["schemas"]["YouView"] | null;
        };
        Watch: {
            /** Format: int64 */
            anchorAt: number;
            contentId: string;
            kind: string;
            openedBy: string;
            paused: boolean;
            /** Format: int64 */
            positionMs: number;
            provider: string;
            /** Format: int64 */
            revision: number;
            title: string;
        };
        YouView: {
            actions: string[];
            /** Format: int64 */
            callAmount: number;
            cards: string[];
            hand: string;
            /** Format: int64 */
            maxRaiseTo: number;
            /** Format: int64 */
            minRaiseTo: number;
            /** Format: int64 */
            rebuy: number;
            /** Format: int32 */
            rebuysLeft: number;
            /** Format: int32 */
            seat: number;
            /** Format: int64 */
            timeBankMs: number;
            turn: boolean;
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
    ping: {
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
                    "*/*": {
                        [key: string]: number;
                    };
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
    durakGames: {
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
                    "*/*": components["schemas"]["DurakSummary"][];
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
    games: {
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
                    "*/*": components["schemas"]["GameSummary"][];
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
    updateRoomSettings: {
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
                "application/json": components["schemas"]["RoomSettings"];
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
    connect: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["Connect"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Session"];
                };
            };
        };
    };
}
