export type Version = 4 | 6;

export interface Ip {
    version: Version;
    value: bigint;
}

const BITS = { 4: 32, 6: 128 } as const;

/** Parses a dotted IPv4 address; null when it is not one. */
export function parseIpv4(text: string): bigint | null {
    const parts = text.split(".");
    if (parts.length !== 4) return null;
    let value = 0n;
    for (const p of parts) {
        if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
        value = (value << 8n) | BigInt(p);
    }
    return value;
}

/** Parses an IPv6 address (`::` shorthand allowed, no zone ids, no embedded IPv4); null when invalid. */
export function parseIpv6(text: string): bigint | null {
    if (!/^[0-9a-fA-F:]+$/.test(text) || text.includes(":::")) return null;
    const halves = text.split("::");
    if (halves.length > 2) return null;
    const side = (s: string) => (s === "" ? [] : s.split(":"));
    const head = side(halves[0]);
    const tail = halves.length === 2 ? side(halves[1]) : [];
    const groups = head.length + tail.length;
    if (halves.length === 1 ? groups !== 8 : groups > 7) return null;
    const all = [...head, ...Array(8 - groups).fill("0"), ...tail];
    let value = 0n;
    for (const g of all) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
        value = (value << 16n) | BigInt(`0x${g}`);
    }
    return value;
}

export function parseIp(text: string): Ip | null {
    const t = text.trim();
    const v4 = parseIpv4(t);
    if (v4 !== null) return { version: 4, value: v4 };
    const v6 = parseIpv6(t);
    return v6 === null ? null : { version: 6, value: v6 };
}

export function formatIpv4(value: bigint): string {
    return [24n, 16n, 8n, 0n].map((s) => String((value >> s) & 255n)).join(".");
}

/** RFC 5952 style: lowercase, leading zeros dropped, the longest run of two or more zero groups becomes `::`. */
export function formatIpv6(value: bigint): string {
    const groups = Array.from({ length: 8 }, (_, i) => Number((value >> BigInt((7 - i) * 16)) & 0xffffn));
    let best = { start: -1, len: 0 };
    for (let i = 0; i < 8; ) {
        if (groups[i] !== 0) {
            i++;
            continue;
        }
        let j = i;
        while (j < 8 && groups[j] === 0) j++;
        if (j - i > best.len) best = { start: i, len: j - i };
        i = j;
    }
    const hex = groups.map((g) => g.toString(16));
    if (best.len < 2) return hex.join(":");
    return `${hex.slice(0, best.start).join(":")}::${hex.slice(best.start + best.len).join(":")}`;
}

export function formatIp(ip: Ip): string {
    return ip.version === 4 ? formatIpv4(ip.value) : formatIpv6(ip.value);
}

/** `mask(24, 32)` is the 32-bit mask with 24 leading ones. */
function mask(prefix: number, bits: number): bigint {
    return ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
}

export interface Subnet {
    version: Version;
    prefix: number;
    address: Ip;
    network: Ip;
    last: Ip;
    total: bigint;
    firstHost: Ip | null;
    lastHost: Ip | null;
    hosts: bigint;
    mask: Ip;
    wildcard: Ip;
}

/** Calculates the subnet of `address/prefix`; a bare address means the full length (/32 or /128). Returns an error message (empty for empty input) otherwise. */
export function calculate(input: string): Subnet | string {
    const text = input.trim();
    if (text === "") return "";
    const [addr, len, ...extra] = text.split("/");
    if (extra.length > 0) return "too many slashes";
    const ip = parseIp(addr);
    if (!ip) return "not an IPv4 or IPv6 address";
    const bits = BITS[ip.version];
    let prefix = bits;
    if (len !== undefined) {
        if (!/^\d{1,3}$/.test(len) || Number(len) > bits) return `prefix must be 0-${bits}`;
        prefix = Number(len);
    }
    const m = mask(prefix, bits);
    const full = (1n << BigInt(bits)) - 1n;
    const net = ip.value & m;
    const last = net | (~m & full);
    const total = 1n << BigInt(bits - prefix);
    const at = (value: bigint): Ip => ({ version: ip.version, value });
    // IPv4 loses the network and broadcast address, except /31 (point to point, RFC 3021) and /32.
    const reserve = ip.version === 4 && prefix < 31;
    return {
        version: ip.version,
        prefix,
        address: ip,
        network: at(net),
        last: at(last),
        total,
        firstHost: reserve ? at(net + 1n) : at(net),
        lastHost: reserve ? at(last - 1n) : at(last),
        hosts: reserve ? total - 2n : total,
        mask: at(m),
        wildcard: at(~m & full),
    };
}

/** A short name for special address ranges; empty when it is an ordinary address. */
export function kind(ip: Ip): string {
    const v = ip.value;
    if (ip.version === 4) {
        const inside = (base: string, prefix: number) => (v & mask(prefix, 32)) === parseIpv4(base);
        if (inside("10.0.0.0", 8) || inside("172.16.0.0", 12) || inside("192.168.0.0", 16)) return "private";
        if (inside("127.0.0.0", 8)) return "loopback";
        if (inside("169.254.0.0", 16)) return "link-local";
        if (inside("100.64.0.0", 10)) return "shared (CGNAT)";
        if (inside("224.0.0.0", 4)) return "multicast";
        if (inside("0.0.0.0", 8)) return "unspecified";
        return "";
    }
    const inside = (base: string, prefix: number) => (v & mask(prefix, 128)) === parseIpv6(base);
    if (v === 1n) return "loopback";
    if (v === 0n) return "unspecified";
    if (inside("fc00::", 7)) return "unique local";
    if (inside("fe80::", 10)) return "link-local";
    if (inside("ff00::", 8)) return "multicast";
    return "";
}

/** The rows shown to the user: label and value. */
export function rows(s: Subnet): [string, string][] {
    const out: [string, string][] = [
        ["address", `${formatIp(s.address)}/${s.prefix}`],
        ["network", formatIp(s.network)],
    ];
    if (s.version === 4) out.push(["netmask", formatIp(s.mask)], ["wildcard", formatIp(s.wildcard)]);
    out.push([s.version === 4 ? "broadcast" : "last address", formatIp(s.last)]);
    if (s.firstHost && s.lastHost && s.hosts > 0n) {
        out.push(["first host", formatIp(s.firstHost)], ["last host", formatIp(s.lastHost)]);
    }
    out.push(["addresses", s.total.toString()]);
    if (s.version === 4) out.push(["usable hosts", s.hosts.toString()]);
    const k = kind(s.address);
    if (k) out.push(["type", k]);
    return out;
}
