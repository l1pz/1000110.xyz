/** A track as the server lists it from a SoundCloud playlist. */
export interface SoundCloudTrack {
    title: string;
    uploader: string;
    durationSec: number | null;
}

export interface ParsedTrack {
    artists: string[];
    title: string;
    /** Remix, edit or version name from the title; empty when the title names none. */
    mix: string;
    durationSec: number | null;
    /** True when there was no `Artist - Title` split, so the artist is the uploader's name. */
    artistGuessed: boolean;
}

const DASH = /^(.+?)\s+[-–—]\s+(.+)$/;
const GROUP = /[([]([^()[\]]*)[)\]]/g;
const FEAT = /^(?:feat\.?|ft\.?|featuring)\s+(.+)$/i;
const MIX_WORD = /\b(?:mix|remix|edit|dub|version|bootleg|rework|vip|flip|refix|remaster(?:ed)?)\b/i;
const JUNK_WORD =
    /\b(?:free\s*(?:download|dl)|fd|buy|premiere|out now|exclusive|preview|clip|snippet|forthcoming|download|dl)\b/i;
const TRAILING_JUNK = /\s*[-|:]?\s*free\s*(?:download|dl)\s*$/i;
const ARTIST_SEPARATOR = /\s*(?:,|&|×|\band\b|\bx\b|\bvs\.?|\bfeat\.?|\bft\.?|\bfeaturing|\bwith)\s*/i;

/** Lowercase, no accents, `&` as "and", letters and digits separated by single spaces. */
export function normalize(text: string): string {
    return text
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

function splitArtists(text: string): string[] {
    return text
        .split(ARTIST_SEPARATOR)
        .map((name) => name.trim())
        .filter(Boolean);
}

/**
 * Splits a SoundCloud title into artists, title and mix. Junk groups (`[FREE DL]`, `(Premiere)`) are dropped,
 * `(feat. X)` joins the artists, and the last group that names a mix (`(Foo Remix)`) becomes `mix`.
 */
export function parseTrack(track: SoundCloudTrack): ParsedTrack {
    const featured: string[] = [];
    let mix = "";
    let text = track.title.replace(/\s+/g, " ").trim();

    text = text.replace(GROUP, (group, inner: string) => {
        const content = inner.trim();
        const feat = FEAT.exec(content);
        if (feat) {
            featured.push(...splitArtists(feat[1]));
            return "";
        }
        if (MIX_WORD.test(content)) {
            mix = content;
            return "";
        }
        return JUNK_WORD.test(content) ? "" : group;
    });
    text = text.replace(TRAILING_JUNK, "").replace(/\s+/g, " ").trim();

    let artists: string[];
    let title: string;
    let artistGuessed = false;
    const dash = DASH.exec(text);
    if (dash) {
        artists = splitArtists(dash[1]);
        title = dash[2];
    } else {
        artists = splitArtists(track.uploader);
        title = text;
        artistGuessed = true;
    }

    // "Artist - Title - Foo Remix": the mix trails after a second dash
    const tail = DASH.exec(title);
    if (tail && MIX_WORD.test(tail[2]) && !mix) {
        title = tail[1];
        mix = tail[2].trim();
    }

    const inline = / (?:feat\.?|ft\.?|featuring) (.+)$/i.exec(title);
    if (inline) {
        featured.push(...splitArtists(inline[1]));
        title = title.slice(0, inline.index);
    }

    return {
        artists: [...artists, ...featured],
        title: title.replace(/^[\s\-–—|:]+|[\s\-–—|:]+$/g, ""),
        mix,
        durationSec: track.durationSec,
        artistGuessed,
    };
}
