import { describe, expect, it } from "vitest";
import {
    calculate,
    formatIp,
    formatIpv6,
    type Ip,
    kind,
    parseIp,
    parseIpv4,
    parseIpv6,
    rows,
} from "../src/features/tools/tools/cidr/cidr";

const ip = (s: string) => parseIp(s) as Ip;

describe("parsing", () => {
    it("parses IPv4", () => {
        expect(parseIpv4("192.168.1.10")).toBe(0xc0a8010an);
        expect(parseIpv4("256.1.1.1")).toBeNull();
        expect(parseIpv4("1.2.3")).toBeNull();
        expect(parseIpv4("1.2.3.4.5")).toBeNull();
        expect(parseIpv4("a.b.c.d")).toBeNull();
    });

    it("parses IPv6 with and without ::", () => {
        expect(parseIpv6("::1")).toBe(1n);
        expect(parseIpv6("::")).toBe(0n);
        expect(parseIpv6("2001:db8::1")).toBe(0x20010db8000000000000000000000001n);
        expect(parseIpv6("1:2:3:4:5:6:7:8")).toBe(0x00010002000300040005000600070008n);
        expect(parseIpv6("1:2:3:4:5:6:7")).toBeNull();
        expect(parseIpv6("1::2::3")).toBeNull();
        expect(parseIpv6("12345::")).toBeNull();
        expect(parseIpv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    });

    it("detects the version", () => {
        expect(parseIp(" 10.0.0.1 ")?.version).toBe(4);
        expect(parseIp("::1")?.version).toBe(6);
        expect(parseIp("nope")).toBeNull();
    });

    it("compresses IPv6 like RFC 5952", () => {
        expect(formatIpv6(0n)).toBe("::");
        expect(formatIpv6(1n)).toBe("::1");
        expect(formatIpv6(ip("2001:0db8:0000:0000:0000:0000:0000:0001").value)).toBe("2001:db8::1");
        // a single zero group is not compressed; the longest run wins
        expect(formatIpv6(ip("1:0:2:3:4:5:6:7").value)).toBe("1:0:2:3:4:5:6:7");
        expect(formatIpv6(ip("1:0:2:0:0:3:0:4").value)).toBe("1:0:2::3:0:4");
    });
});

describe("calculate", () => {
    const sub = (s: string) => {
        const r = calculate(s);
        if (typeof r === "string") throw new Error(r);
        return r;
    };

    it("handles a /24", () => {
        const s = sub("192.168.1.10/24");
        expect(formatIp(s.network)).toBe("192.168.1.0");
        expect(formatIp(s.last)).toBe("192.168.1.255");
        expect(formatIp(s.mask)).toBe("255.255.255.0");
        expect(formatIp(s.wildcard)).toBe("0.0.0.255");
        expect(s.total).toBe(256n);
        expect(s.hosts).toBe(254n);
        expect(formatIp(s.firstHost as Ip)).toBe("192.168.1.1");
        expect(formatIp(s.lastHost as Ip)).toBe("192.168.1.254");
    });

    it("handles /0, /31 and /32", () => {
        expect(sub("1.2.3.4/0").total).toBe(2n ** 32n);
        expect(formatIp(sub("1.2.3.4/0").mask)).toBe("0.0.0.0");
        const p2p = sub("10.0.0.4/31");
        expect(p2p.hosts).toBe(2n);
        expect(formatIp(p2p.firstHost as Ip)).toBe("10.0.0.4");
        expect(formatIp(p2p.lastHost as Ip)).toBe("10.0.0.5");
        const one = sub("10.0.0.7");
        expect(one.prefix).toBe(32);
        expect(one.hosts).toBe(1n);
    });

    it("handles IPv6", () => {
        const s = sub("2001:db8:abcd::1/48");
        expect(formatIp(s.network)).toBe("2001:db8:abcd::");
        expect(formatIp(s.last)).toBe("2001:db8:abcd:ffff:ffff:ffff:ffff:ffff");
        expect(s.total).toBe(2n ** 80n);
        expect(sub("::/0").total).toBe(2n ** 128n);
        expect(sub("::1").total).toBe(1n);
    });

    it("reports errors", () => {
        expect(calculate("")).toBe("");
        expect(calculate("1.2.3.4/33")).toMatch(/0-32/);
        expect(calculate("::1/129")).toMatch(/0-128/);
        expect(calculate("1.2.3.4/x")).toMatch(/prefix/);
        expect(calculate("1.2.3.4/8/8")).toMatch(/slash/);
        expect(calculate("hello")).toMatch(/not an/);
    });
});

describe("kind and rows", () => {
    it("names special ranges", () => {
        expect(kind(ip("192.168.0.1"))).toBe("private");
        expect(kind(ip("172.31.255.255"))).toBe("private");
        expect(kind(ip("172.32.0.0"))).toBe("");
        expect(kind(ip("127.0.0.1"))).toBe("loopback");
        expect(kind(ip("8.8.8.8"))).toBe("");
        expect(kind(ip("fe80::1"))).toBe("link-local");
        expect(kind(ip("fd12::1"))).toBe("unique local");
        expect(kind(ip("::1"))).toBe("loopback");
    });

    it("lists labelled rows", () => {
        const labels = rows(calculate("10.1.2.3/8") as never).map(([l]) => l);
        expect(labels).toEqual([
            "address",
            "network",
            "netmask",
            "wildcard",
            "broadcast",
            "first host",
            "last host",
            "addresses",
            "usable hosts",
            "type",
        ]);
        const v6 = rows(calculate("2001:db8::/32") as never).map(([l]) => l);
        expect(v6).not.toContain("netmask");
    });
});
