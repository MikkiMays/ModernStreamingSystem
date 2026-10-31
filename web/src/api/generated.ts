export interface paths {
    "/api/v1/admin/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["audit"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/blocks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["blocks"];
        put?: never;
        post: operations["block"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/blocks/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["lift"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/maintenance": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["maintenance"];
        put?: never;
        post: operations["maintenance_1"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/meetings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["meetings"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/now": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["now"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/quality": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["quality"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/rooms/{id}/close": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["close"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/server": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["server"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["login"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/shield": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["shield"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/support": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["tickets"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/support/{id}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["status"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
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
    "/api/v1/catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["catalog"];
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
    "/api/v1/favorites/{id}/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["settings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/favorites/groups": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["list_1"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/favorites/groups/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["put"];
        post?: never;
        delete: operations["remove_1"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/favorites/groups/order": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["reorder_1"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/favorites/order": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["reorder"];
        post?: never;
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
    "/api/v1/proof": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["proof"];
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
    "/api/v1/rooms/{id}/client-report": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["clientReport"];
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
    "/api/v1/rooms/{id}/quality": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["report"];
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
    "/api/v1/rooms/presence": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["presence"];
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
    "/api/v1/support": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["submit"];
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
            executable: boolean;
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
        Block: {
            /** Format: int64 */
            createdAt?: number;
            createdBy?: string;
            /** Format: int64 */
            expiresAt?: number;
            id?: string;
            kind?: string;
            /** Format: int64 */
            liftedAt?: number;
            reason?: string;
            subject?: string;
        };
        BlockRequest: {
            kind?: string;
            memberId?: string;
            reason?: string;
            roomId?: string;
            subject?: string;
            term?: string;
        };
        Bucket: {
            /** Format: int32 */
            meetings?: number;
            /** Format: int64 */
            upToSeconds?: number;
        };
        Capabilities: {
            admissionOpen: boolean;
            /** Format: int32 */
            favoritesMax: number;
            /** Format: int64 */
            fileMaxBytes: number;
            frameRates: number[];
            maintenance?: boolean;
            /** Format: int32 */
            maxParticipants: number;
            /** Format: int32 */
            maxScreens: number;
            name: string;
            passwordRequired: boolean;
            quality: components["schemas"]["QualityRules"];
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
        Challenge: {
            algorithm?: string;
            challenge?: string;
            /** Format: int64 */
            maxnumber?: number;
            salt?: string;
            signature?: string;
        };
        ChessMove: {
            /** Format: int64 */
            at: number;
            fen: string;
            /** Format: int32 */
            ply: number;
            san: string;
            uci: string;
        };
        ChessPlayer: {
            away: boolean;
            memberId: string;
            name: string;
        };
        ChessView: {
            /** Format: int64 */
            anchorAt: number;
            black: components["schemas"]["ChessPlayer"] | null;
            /** Format: int64 */
            blackMs: number;
            check: boolean;
            claimableDraws: string[];
            claimableMoves: string[];
            /** Format: int64 */
            closesAt: number;
            /** Format: int64 */
            deadline: number;
            drawOffer: string | null;
            fen: string;
            /** Format: int64 */
            finishedAt: number;
            hostId: string;
            id: string;
            /** Format: int64 */
            incrementMs: number;
            initialFen: string;
            legalMoves: string[];
            moves: components["schemas"]["ChessMove"][];
            pgn: string;
            phase: string;
            /** Format: int32 */
            ply: number;
            preset: string;
            rematchRequests: string[];
            result: string | null;
            /** Format: int64 */
            revision: number;
            /** Format: int64 */
            startedAt: number;
            turn: string;
            white: components["schemas"]["ChessPlayer"] | null;
            /** Format: int64 */
            whiteMs: number;
            winner: string | null;
        };
        CinemaTraffic: {
            /** Format: int32 */
            percent?: number;
        };
        Close: {
            blockCreator?: boolean;
            term?: string;
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
            image?: string;
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
            type: "leave" | "close" | "invite.create" | "invite.revoke" | "participant.remove" | "participant.approve" | "message.send" | "media.lost" | "media.restored" | "screen.started" | "screen.preview" | "view.open" | "view.close" | "view.playing" | "microphone.mute" | "media.decode" | "profile.avatar" | "watch.open" | "watch.play" | "watch.pause" | "watch.seek" | "watch.close" | "poker.open" | "poker.close" | "poker.sit" | "poker.stand" | "poker.deal" | "poker.next" | "poker.act" | "poker.settings" | "poker.rebuy" | "poker.reveal" | "durak.open" | "durak.close" | "durak.sit" | "durak.stand" | "durak.deal" | "durak.act" | "durak.settings" | "durak.react" | "chess.open" | "chess.close" | "chess.sit" | "chess.stand" | "chess.start" | "chess.settings" | "chess.move" | "chess.act" | "gartic.open" | "gartic.close" | "gartic.join" | "gartic.leave" | "gartic.settings" | "gartic.start" | "gartic.choose" | "gartic.draw" | "gartic.canvas" | "gartic.guess" | "gartic.submit" | "gartic.reveal" | "presence.confirm";
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
        Day: {
            day?: string;
            /** Format: int64 */
            humanSeconds?: number;
            /** Format: int32 */
            meetings?: number;
            /** Format: int32 */
            peakHumans?: number;
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
        DurakPlay: {
            card: string;
            /** @enum {string} */
            option: "attack" | "beat" | "transfer";
            under: string | null;
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
        DurakReaction: {
            /** Format: int64 */
            at: number;
            /** Format: int64 */
            expiresAt: number;
            /** Format: int64 */
            id: number;
            /** Format: int32 */
            seat: number;
            stickerId: string;
        };
        DurakResult: {
            /** Format: int64 */
            at: number;
            /** Format: int32 */
            bouts: number;
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
            paused?: boolean;
            /** Format: int64 */
            pausedAt?: number;
            /** Format: int64 */
            pausedRemaining?: number;
            phase: string;
            reactions?: components["schemas"]["DurakReaction"][];
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
            visualEvents?: components["schemas"]["GameVisualEvent"][];
            you: components["schemas"]["DurakYou"] | null;
        };
        DurakYou: {
            actions: string[];
            cards: string[];
            plays?: components["schemas"]["DurakPlay"][];
            /** Format: int32 */
            seat: number;
            turn: boolean;
        };
        Entry: {
            contact?: string;
            /** Format: int64 */
            createdAt?: number;
            diagnostics?: string;
            id?: string;
            issues?: string[];
            message?: string;
            /** Format: int64 */
            notifiedAt?: number;
            number?: string;
            /** @enum {string} */
            status?: "NEW" | "OPEN" | "DONE";
            /** Format: int64 */
            statusAt?: number;
            topic?: string;
        };
        Event: {
            eventId: string;
            /** Format: int64 */
            occurredAt: number;
            payload: components["schemas"]["EventPayload"];
            /** Format: int64 */
            sequence: number;
            /** @enum {string} */
            type: "room.changed" | "message.created" | "files.changed" | "screen.started" | "screen.first_viewer" | "meeting.warning";
            /** Format: int32 */
            version: number;
        };
        EventPayload: {
            message: components["schemas"]["Message"] | null;
            participantId?: string | null;
            screenId?: string | null;
        };
        Favorite: {
            alias?: string | null;
            canJoin: boolean;
            closed: boolean;
            code: string;
            groupId?: string | null;
            pinned: boolean;
            roomId: string;
            /** Format: int64 */
            savedAt: number;
            title: string;
        };
        FavoriteSettings: {
            alias?: string | null;
            /** Format: uuid */
            groupId?: string | null;
            pinned?: boolean;
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
        GameVisualEvent: {
            /** Format: int64 */
            at: number;
            cards: string[];
            /** Format: int32 */
            count: number;
            /** Format: int32 */
            fromSeat: null | number;
            /** Format: int64 */
            id: number;
            /** Format: int32 */
            toSeat: null | number;
            /** @enum {string} */
            type: "deal" | "draw" | "play" | "transfer" | "take" | "discard";
        };
        GarticAlbum: {
            /** Format: int32 */
            entries: number;
            /** Format: int32 */
            index: number;
            ownerId: string;
            ownerName: string;
        };
        GarticEntry: {
            authorId: string;
            authorName: string;
            kind: string;
            skipped: boolean;
            /** Format: int32 */
            step: number;
            strokes: components["schemas"]["GarticStroke"][];
            text: string | null;
        };
        GarticGuess: {
            /** Format: int64 */
            at: number;
            correct: boolean;
            /** Format: int64 */
            id: number;
            memberId: string;
            name: string;
            text: string;
        };
        GarticPlayer: {
            active: boolean;
            away: boolean;
            guessed: boolean;
            memberId: string;
            name: string;
            /** Format: int32 */
            score: number;
            submitted: boolean;
        };
        GarticStroke: {
            color: string;
            id: string;
            points: number[][];
            /** Format: int32 */
            width: number;
        };
        GarticView: {
            albums: components["schemas"]["GarticAlbum"][];
            answer: string | null;
            canvas: components["schemas"]["GarticStroke"][];
            /** Format: int64 */
            closesAt: number;
            /** Format: int64 */
            deadline: number;
            drawerId: string | null;
            gameId: string;
            guesses: components["schemas"]["GarticGuess"][];
            hint: string | null;
            hostId: string;
            mode: string;
            phase: string;
            /** Format: int64 */
            phaseStartedAt: number;
            players: components["schemas"]["GarticPlayer"][];
            /** Format: int32 */
            revealAlbum: number;
            revealed: components["schemas"]["GarticEntry"] | null;
            /** Format: int32 */
            revealEntry: number;
            /** Format: int64 */
            revision: number;
            /** Format: int32 */
            round: number;
            /** Format: int32 */
            rounds: number;
            /** Format: int32 */
            step: number;
            /** Format: int32 */
            totalSteps: number;
            /** Format: int32 */
            turnSeconds: number;
            /** Format: int64 */
            turnToken: number;
            you: components["schemas"]["GarticYou"] | null;
        };
        GarticYou: {
            canDraw: boolean;
            canGuess: boolean;
            canSubmit: boolean;
            choices: string[];
            memberId: string;
            playing: boolean;
            previous: components["schemas"]["GarticEntry"] | null;
            prompt: string | null;
            submitted: boolean;
        };
        Group: {
            id: string;
            title: string;
        };
        GroupOrder: {
            groupIds: string[];
        };
        GroupTitle: {
            title: string;
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
            participantCan?: string[];
            title?: string;
            watching?: boolean;
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
        Level: {
            /** Format: int32 */
            fps: number;
            /** Format: int32 */
            resolution: number;
        };
        LiveRoom: {
            approvalRequired?: boolean;
            /** Format: int32 */
            bots?: number;
            code?: string;
            /** Format: int32 */
            connected?: number;
            /** Format: int64 */
            createdAt?: number;
            createdHere?: boolean;
            /** Format: int64 */
            endsAt?: number;
            /** Format: int32 */
            humans?: number;
            id?: string;
            integrations?: string[];
            /** Format: int32 */
            screens?: number;
            /** Format: int64 */
            startedAt?: number;
            /** Format: int32 */
            waiting?: number;
        };
        Login: {
            password?: string;
        };
        MaintenanceRequest: {
            on?: boolean;
        };
        MaintenanceState: {
            on?: boolean;
            /** Format: int64 */
            since?: number;
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
        Moved: {
            id?: string;
            number?: string;
            /** @enum {string} */
            status?: "NEW" | "OPEN" | "DONE";
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
        Now: {
            /** Format: int32 */
            bots?: number;
            /** Format: int32 */
            connected?: number;
            /** Format: int32 */
            humans?: number;
            /** Format: int32 */
            live?: number;
            rooms?: components["schemas"]["LiveRoom"][];
            /** Format: int32 */
            screens?: number;
            /** Format: int64 */
            serverTime?: number;
            /** Format: int32 */
            waiting?: number;
        };
        Order: {
            roomIds: string[];
        };
        Outgoing: {
            chat?: string;
            id?: string;
            text?: string;
        };
        Page: {
            items?: components["schemas"]["Event"][];
            next?: string;
        };
        Participant: {
            avatar: string;
            decodes?: string[];
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
        Presence: {
            code?: string;
            /** Format: int32 */
            people?: number;
            roomId?: string;
            state?: string;
            title?: string;
        };
        PresenceQuery: {
            rooms: components["schemas"]["PresenceRoom"][];
        };
        PresenceRoom: {
            credential: string;
            /** Format: uuid */
            roomId: string;
        };
        Quality: {
            /** Format: int32 */
            bitrateKbps?: number;
            codecs?: {
                [key: string]: number;
            };
            days?: components["schemas"]["QualityDay"][];
            /** Format: int32 */
            freezes?: number;
            /** Format: double */
            freezesPerHour?: number;
            /** Format: int64 */
            from?: number;
            /** Format: int32 */
            jitterMs?: number;
            /** Format: double */
            lossPercent?: number;
            /** Format: double */
            lossyShare?: number;
            /** Format: int32 */
            meetings?: number;
            recent?: components["schemas"]["QualityMeeting"][];
            /** Format: double */
            relayShare?: number;
            /** Format: int32 */
            reports?: number;
            /** Format: int32 */
            rttMaxMs?: number;
            /** Format: int32 */
            rttMs?: number;
            /** Format: int64 */
            seconds?: number;
            /** Format: int64 */
            to?: number;
        };
        QualityDay: {
            day?: string;
            /** Format: double */
            lossPercent?: number;
            /** Format: int32 */
            reports?: number;
            /** Format: int32 */
            rttMs?: number;
        };
        QualityMeeting: {
            code?: string;
            /** Format: int32 */
            freezes?: number;
            /** Format: int32 */
            jitterMs?: number;
            /** Format: double */
            lossPercent?: number;
            relay?: boolean;
            /** Format: int32 */
            reports?: number;
            /** Format: int32 */
            rttMaxMs?: number;
            /** Format: int32 */
            rttMs?: number;
            /** Format: int64 */
            startedAt?: number;
        };
        QualityRules: {
            cameraYieldsToScreen: boolean;
            ceiling: components["schemas"]["Level"];
            default: components["schemas"]["Level"];
            /** Format: int64 */
            settleMs: number;
        };
        Receipt: {
            id?: string;
            number?: string;
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
        Report: {
            /** Format: int32 */
            bitrateKbps?: number;
            codec?: string;
            /** Format: int32 */
            freezes?: number;
            /** Format: int32 */
            freezeSeconds?: number;
            /** Format: int32 */
            jitterMs?: number;
            /** Format: double */
            lossPercent?: number;
            /** Format: int32 */
            lossySeconds?: number;
            path: string;
            publishCodec?: string;
            /** Format: int32 */
            rttMs?: number;
            /** Format: int32 */
            seconds?: number;
        };
        Request: {
            consent?: boolean;
            contact?: string;
            diagnostics?: string;
            issues?: string[];
            message: string;
            topic: string;
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
        RoomYou: {
            can: string[];
            /** Format: int64 */
            presenceBy?: null | number;
        };
        RxSummary: {
            switches?: components["schemas"]["TxSwitch"][];
            tracks: components["schemas"]["RxTrack"][];
            tx?: components["schemas"]["TxTrack"][];
        };
        RxTrack: {
            /** Format: int64 */
            concealed?: number;
            /** Format: int32 */
            delayMs?: number;
            /** Format: int32 */
            events?: number;
            kind: string;
            /** Format: int32 */
            lost?: number;
            /** Format: int32 */
            targetMs?: number;
            /** Format: int64 */
            total?: number;
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
        Server: {
            /** Format: int64 */
            activityDailyMs?: number;
            /** Format: int64 */
            auditMs?: number;
            /** Format: int32 */
            autoBlockCount?: number;
            /** Format: int64 */
            autoBlockTermMs?: number;
            /** Format: int64 */
            autoBlockWindowMs?: number;
            /** Format: int64 */
            blockDefaultMs?: number;
            /** Format: int32 */
            blocksActive?: number;
            build?: string;
            /** Format: int64 */
            meetingStatsMs?: number;
            shield?: boolean;
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
            chess?: components["schemas"]["ChessView"] | null;
            /** Format: int32 */
            cinemaTraffic?: null | number;
            /** Format: int64 */
            closedAt: null | number;
            code: string;
            /** Format: int64 */
            createdAt: number;
            durak: components["schemas"]["DurakView"] | null;
            /** Format: int64 */
            durakGamesAt: number;
            /** Format: int64 */
            endsAt?: null | number;
            gartic?: components["schemas"]["GarticView"] | null;
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
            /** Format: int64 */
            startedAt?: null | number;
            title: string;
            watch: components["schemas"]["Watch"] | null;
            you?: components["schemas"]["RoomYou"] | null;
        };
        StatusChange: {
            /** @enum {string} */
            status: "NEW" | "OPEN" | "DONE";
        };
        Summary: {
            days?: components["schemas"]["Day"][];
            durations?: components["schemas"]["Bucket"][];
            endReasons?: {
                [key: string]: number;
            };
            /** Format: int64 */
            from?: number;
            /** Format: int64 */
            humanSeconds?: number;
            integrations?: {
                [key: string]: number;
            };
            /** Format: int64 */
            joinFailures?: number;
            /** Format: int64 */
            joins?: number;
            /** Format: int64 */
            longestSeconds?: number;
            /** Format: int64 */
            medianSeconds?: number;
            /** Format: int32 */
            meetings?: number;
            /** Format: int32 */
            peakHumans?: number;
            /** Format: int64 */
            to?: number;
            /** Format: int64 */
            uniqueDevices?: number;
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
            visualEvents?: components["schemas"]["GameVisualEvent"][];
            you: components["schemas"]["YouView"] | null;
        };
        TelegramStatus: {
            chat: string;
            /** @enum {string} */
            status: "NEW" | "OPEN" | "DONE";
        };
        TxSwitch: {
            from: string;
            reason: string;
            source: string;
            to: string;
        };
        TxTrack: {
            /** Format: double */
            bandwidthSeconds?: number;
            codec: string;
            /** Format: double */
            cpuSeconds?: number;
            hw: string;
            /** Format: double */
            otherSeconds?: number;
            /** Format: double */
            seconds?: number;
            source: string;
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
    audit: {
        parameters: {
            query?: {
                code?: string;
                cursor?: string;
                from?: number;
                group?: string;
                ip?: string;
                limit?: number;
                outcome?: string;
                room?: string;
                to?: number;
            };
            header?: {
                "X-Cord-Admin"?: string;
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
                    "*/*": components["schemas"]["Page"];
                };
            };
        };
    };
    blocks: {
        parameters: {
            query?: never;
            header?: {
                "X-Cord-Admin"?: string;
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
                    "*/*": components["schemas"]["Block"][];
                };
            };
        };
    };
    block: {
        parameters: {
            query?: never;
            header?: {
                "X-Cord-Admin"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BlockRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Block"][];
                };
            };
        };
    };
    lift: {
        parameters: {
            query?: never;
            header?: {
                "X-Cord-Admin"?: string;
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
    maintenance: {
        parameters: {
            query?: never;
            header?: {
                "X-Cord-Admin"?: string;
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
                    "*/*": components["schemas"]["MaintenanceState"];
                };
            };
        };
    };
    maintenance_1: {
        parameters: {
            query?: never;
            header?: {
                "X-Cord-Admin"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MaintenanceRequest"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["MaintenanceState"];
                };
            };
        };
    };
    meetings: {
        parameters: {
            query: {
                from: number;
                to: number;
                tz?: number;
            };
            header?: {
                "X-Cord-Admin"?: string;
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
                    "*/*": components["schemas"]["Summary"];
                };
            };
        };
    };
    now: {
        parameters: {
            query?: never;
            header?: {
                "X-Cord-Admin"?: string;
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
                    "*/*": components["schemas"]["Now"];
                };
            };
        };
    };
    quality: {
        parameters: {
            query: {
                from: number;
                to: number;
                tz?: number;
            };
            header?: {
                "X-Cord-Admin"?: string;
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
                    "*/*": components["schemas"]["Quality"];
                };
            };
        };
    };
    close: {
        parameters: {
            query?: never;
            header?: {
                "X-Cord-Admin"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["Close"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Now"];
                };
            };
        };
    };
    server: {
        parameters: {
            query?: never;
            header?: {
                "X-Cord-Admin"?: string;
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
                    "*/*": components["schemas"]["Server"];
                };
            };
        };
    };
    login: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Login"];
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
    shield: {
        parameters: {
            query?: never;
            header?: {
                "X-Cord-Admin"?: string;
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
                content?: never;
            };
        };
    };
    tickets: {
        parameters: {
            query?: {
                before?: number;
            };
            header?: {
                "X-Cord-Admin"?: string;
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
                    "*/*": components["schemas"]["Entry"][];
                };
            };
        };
    };
    status: {
        parameters: {
            query?: never;
            header?: {
                "X-Cord-Admin"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StatusChange"];
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
    catalog: {
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
                    "*/*": string;
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
    settings: {
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
                "application/json": components["schemas"]["FavoriteSettings"];
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
    list_1: {
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
                    "*/*": components["schemas"]["Group"][];
                };
            };
        };
    };
    put: {
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
                "application/json": components["schemas"]["GroupTitle"];
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
    remove_1: {
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
    reorder_1: {
        parameters: {
            query?: never;
            header: {
                Authorization: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GroupOrder"];
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
    reorder: {
        parameters: {
            query?: never;
            header: {
                Authorization: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Order"];
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
    proof: {
        parameters: {
            query: {
                for: string;
            };
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
                    "*/*": components["schemas"]["Challenge"];
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
    clientReport: {
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
                "application/json": components["schemas"]["Report"];
            };
        };
        responses: {
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
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
    report: {
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
                "application/json": components["schemas"]["RxSummary"];
            };
        };
        responses: {
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
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
    presence: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PresenceQuery"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Presence"][];
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
    submit: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Request"];
            };
        };
        responses: {
            /** @description OK */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "*/*": components["schemas"]["Receipt"];
                };
            };
        };
    };
}
