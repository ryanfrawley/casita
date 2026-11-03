import { expect, test } from "bun:test";
import { endpoints } from "./client.ts";

test("an http URL maps to http and ws on the same host", () => {
  expect(endpoints("http://localhost:8123")).toEqual({
    http: "http://localhost:8123",
    ws: "ws://localhost:8123/ws",
  });
});

test("an https URL maps to https and wss", () => {
  expect(endpoints("https://home.example.com")).toEqual({
    http: "https://home.example.com",
    ws: "wss://home.example.com/ws",
  });
});

test("a ws URL maps to http and ws", () => {
  expect(endpoints("ws://10.0.0.5:8123")).toEqual({
    http: "http://10.0.0.5:8123",
    ws: "ws://10.0.0.5:8123/ws",
  });
});

test("a wss URL maps to https and wss", () => {
  expect(endpoints("wss://home.example.com:8443")).toEqual({
    http: "https://home.example.com:8443",
    ws: "wss://home.example.com:8443/ws",
  });
});

test("the port is kept, and a default port is dropped", () => {
  expect(endpoints("http://host:80").http).toBe("http://host");
  expect(endpoints("https://host:443").ws).toBe("wss://host/ws");
  expect(endpoints("https://host:8443").http).toBe("https://host:8443");
});

test("a trailing slash, path, query and fragment are dropped", () => {
  expect(endpoints("http://host:8123/")).toEqual({
    http: "http://host:8123",
    ws: "ws://host:8123/ws",
  });
  expect(endpoints("http://host:8123/ws?x=1#frag").ws).toBe("ws://host:8123/ws");
});

test("an IPv6 host keeps its brackets", () => {
  expect(endpoints("http://[::1]:8123")).toEqual({
    http: "http://[::1]:8123",
    ws: "ws://[::1]:8123/ws",
  });
});

test("an unparseable URL throws", () => {
  expect(() => endpoints("not a url")).toThrow();
});

test("a URL without a scheme is treated as http", () => {
  expect(endpoints("localhost:8123")).toEqual({
    http: "http://localhost:8123",
    ws: "ws://localhost:8123/ws",
  });
});
