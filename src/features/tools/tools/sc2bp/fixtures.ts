import type { Api, Created, PlaylistInfo } from "./api";
import type { Candidate } from "./match";

/** A fake server for `npm run dev`, so the screen can be looked at without the backend. Never bundled for production. */
const tracks: PlaylistInfo["tracks"] = [
    { title: "Solomun - Higher State [FREE DL]", uploader: "Solomun", durationSec: 400 },
    { title: "Dixon - Transmoderna (Âme Remix)", uploader: "Innervisions", durationSec: 531 },
    { title: "Bonobo - Kerala (Live)", uploader: "Some Channel", durationSec: 301 },
    { title: "Unreleased Bootleg ID", uploader: "Some Channel", durationSec: 190 },
    { title: "Peggy Gou - Starsilk feat. Jane Doe", uploader: "Peggy Gou", durationSec: 360 },
];

const c = (id: number, title: string, mix: string, artists: string[], durationSec: number): Candidate => ({
    id,
    title,
    mix,
    artists,
    durationSec,
});

const catalogue: Candidate[][] = [
    [c(1, "Higher State", "Original Mix", ["Solomun"], 401), c(2, "Higher State", "Extended Mix", ["Solomun"], 480)],
    [
        c(3, "Transmoderna", "Original Mix", ["Dixon"], 520),
        c(4, "Transmoderna", "Âme Remix", ["Dixon"], 530),
        c(5, "Transmoderna", "Dub Mix", ["Dixon"], 410),
    ],
    [c(6, "Kerala", "Original Mix", ["Bonobo"], 270), c(7, "Keralaa", "Radio Edit", ["Other Artist"], 200)],
    [],
    [c(8, "Starsilk", "Original Mix", ["Peggy Gou", "Jane Doe"], 361)],
];

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function fakeApi(): Api {
    let asked = 0;
    return {
        async me() {
            await pause(100);
        },
        async playlist() {
            await pause(400);
            return { name: "Demo set", tracks };
        },
        async search(queries) {
            await pause(400);
            const out = queries.map((_, i) => catalogue[(asked + i) % catalogue.length] ?? []);
            asked += queries.length;
            return out;
        },
        async create(name, ids): Promise<Created> {
            await pause(600);
            return { name, added: ids.length, url: "https://www.beatport.com/library/playlists" };
        },
    };
}
