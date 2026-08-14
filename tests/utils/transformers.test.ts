import { describe, it, expect } from "vitest";
import { Buffer } from "buffer";
import { DockerLogFrameParser } from "../../src/utils/transformers";

// Mirrors Docker's multiplexed stream frame format: [1 byte stream type][3 bytes zero][4 bytes size][payload]
function frame(streamType: number, payload: string) {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

describe("DockerLogFrameParser", () => {
  it("parses a single stdout frame", () => {
    const parser = new DockerLogFrameParser();
    const frames = parser.push(frame(1, "hello\n"));

    expect(frames).toEqual([{ stream: "stdout", message: "hello\n" }]);
  });

  it("parses a single stderr frame", () => {
    const parser = new DockerLogFrameParser();
    const frames = parser.push(frame(2, "oops\n"));

    expect(frames).toEqual([{ stream: "stderr", message: "oops\n" }]);
  });

  it("preserves original interleaved order across multiple frames in one push", () => {
    const parser = new DockerLogFrameParser();
    const buf = Buffer.concat([frame(1, "out1\n"), frame(2, "err1\n"), frame(1, "out2\n")]);

    const frames = parser.push(buf);

    expect(frames).toEqual([
      { stream: "stdout", message: "out1\n" },
      { stream: "stderr", message: "err1\n" },
      { stream: "stdout", message: "out2\n" },
    ]);
  });

  it("buffers a frame split mid-header across two chunks", () => {
    const parser = new DockerLogFrameParser();
    const full = frame(1, "hello\n");

    const firstChunk = full.subarray(0, 5); // splits inside the 8-byte header
    const secondChunk = full.subarray(5);

    expect(parser.push(firstChunk)).toEqual([]);
    expect(parser.push(secondChunk)).toEqual([{ stream: "stdout", message: "hello\n" }]);
  });

  it("buffers a frame split mid-payload across two chunks", () => {
    const parser = new DockerLogFrameParser();
    const full = frame(1, "hello world\n");

    const firstChunk = full.subarray(0, 12); // full header + partial payload
    const secondChunk = full.subarray(12);

    expect(parser.push(firstChunk)).toEqual([]);
    expect(parser.push(secondChunk)).toEqual([{ stream: "stdout", message: "hello world\n" }]);
  });

  it("emits complete frames immediately and holds back only the trailing partial one", () => {
    const parser = new DockerLogFrameParser();
    const complete = frame(1, "complete\n");
    const partial = frame(2, "incomplete\n").subarray(0, 5);

    const frames = parser.push(Buffer.concat([complete, partial]));

    expect(frames).toEqual([{ stream: "stdout", message: "complete\n" }]);
  });

  it("strips ANSI codes from message content", () => {
    const parser = new DockerLogFrameParser();
    const frames = parser.push(frame(1, "[31mred[0m\n"));

    expect(frames).toEqual([{ stream: "stdout", message: "red\n" }]);
  });

  it("treats an unrecognized stream type byte as stdout", () => {
    const parser = new DockerLogFrameParser();
    const frames = parser.push(frame(0, "stdin-typed\n"));

    expect(frames).toEqual([{ stream: "stdout", message: "stdin-typed\n" }]);
  });

  it("returns an empty array for an empty buffer", () => {
    const parser = new DockerLogFrameParser();
    expect(parser.push(Buffer.alloc(0))).toEqual([]);
  });

  it("carries state across many small pushes for the same stream", () => {
    const parser = new DockerLogFrameParser();
    const full = frame(1, "abcdefghij\n");

    const collected = [];
    for (let i = 0; i < full.length; i++) {
      collected.push(...parser.push(full.subarray(i, i + 1)));
    }

    expect(collected).toEqual([{ stream: "stdout", message: "abcdefghij\n" }]);
  });
});
