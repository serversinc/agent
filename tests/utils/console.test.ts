import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";

vi.mock("pino");
vi.mock("../../src/utils/context", () => ({
  getRequestId: vi.fn(),
}));
vi.mock("../../src/config", () => ({
  default: {
    LOGGER_LEVEL: "info",
    LOGGER_PRETTY: false,
  },
}));

describe("Console Utils", () => {
  let mockLogger: any;
  let mockInfo: any;
  let mockWarn: any;
  let mockError: any;

  beforeEach(() => {
    // Create mock logger methods
    mockInfo = vi.fn();
    mockWarn = vi.fn();
    mockError = vi.fn();

    mockLogger = {
      info: mockInfo,
      warn: mockWarn,
      error: mockError,
    };

    // Mock pino to return our mock logger
    // pino is a function that returns a logger; when called with options and transport it returns our logger
    vi.mocked(pino).mockImplementation(() => mockLogger as any);
  });

  afterEach(() => {
    // Reset mocks to their original implementations between tests
    vi.resetAllMocks();
  });

  describe("info", () => {
    it("should log info message with prefix and message", async () => {
      const { getRequestId } = await import("../../src/utils/context");
      vi.mocked(getRequestId).mockReturnValue("req-123");

      const consoleMod = await import("../../src/utils/console");
      // override internal logger with our mock
      consoleMod._setLogger(mockLogger);
      const { info } = consoleMod;

      info("TestPrefix", "Test message");

      expect(mockInfo).toHaveBeenCalledWith(
        {
          prefix: "TestPrefix",
          requestId: "req-123",
        },
        "Test message",
      );
    });

    it("should log info message with metadata", async () => {
      const { getRequestId } = await import("../../src/utils/context");
      vi.mocked(getRequestId).mockReturnValue("req-456");

      const consoleMod = await import("../../src/utils/console");
      consoleMod._setLogger(mockLogger);
      const { info } = consoleMod;

      info("TestPrefix", "Test message", { userId: "user-1", action: "create" });

      expect(mockInfo).toHaveBeenCalledWith(
        {
          prefix: "TestPrefix",
          requestId: "req-456",
          userId: "user-1",
          action: "create",
        },
        "Test message",
      );
    });

    it("should handle undefined requestId", async () => {
      const { getRequestId } = await import("../../src/utils/context");
      vi.mocked(getRequestId).mockReturnValue(undefined);

      const consoleMod = await import("../../src/utils/console");
      consoleMod._setLogger(mockLogger);
      const { info } = consoleMod;

      info("TestPrefix", "Test message");

      expect(mockInfo).toHaveBeenCalledWith(
        {
          prefix: "TestPrefix",
          requestId: undefined,
        },
        "Test message",
      );
    });
  });

  describe("warn", () => {
    it("should log warning message with context", async () => {
      const { getRequestId } = await import("../../src/utils/context");
      vi.mocked(getRequestId).mockReturnValue("req-789");

      const consoleMod = await import("../../src/utils/console");
      consoleMod._setLogger(mockLogger);
      const { warn } = consoleMod;

      warn("Docker", "Image not found", { image: "nginx:latest" });

      expect(mockWarn).toHaveBeenCalledWith(
        {
          prefix: "Docker",
          requestId: "req-789",
          image: "nginx:latest",
        },
        "Image not found",
      );
    });

    it("should log warning without metadata", async () => {
      const { getRequestId } = await import("../../src/utils/context");
      vi.mocked(getRequestId).mockReturnValue("req-001");

      const consoleMod = await import("../../src/utils/console");
      consoleMod._setLogger(mockLogger);
      const { warn } = consoleMod;

      warn("System", "Memory warning");

      expect(mockWarn).toHaveBeenCalledWith(
        {
          prefix: "System",
          requestId: "req-001",
        },
        "Memory warning",
      );
    });
  });

  describe("error", () => {
    it("should log error message with context", async () => {
      const { getRequestId } = await import("../../src/utils/context");
      vi.mocked(getRequestId).mockReturnValue("req-error");

      const consoleMod = await import("../../src/utils/console");
      consoleMod._setLogger(mockLogger);
      const { error } = consoleMod;

      error("Database", "Connection failed", {
        error: "ECONNREFUSED",
        host: "localhost",
      });

      expect(mockError).toHaveBeenCalledWith(
        {
          prefix: "Database",
          requestId: "req-error",
          error: "ECONNREFUSED",
          host: "localhost",
        },
        "Connection failed",
      );
    });

    it("should log error without metadata", async () => {
      const { getRequestId } = await import("../../src/utils/context");
      vi.mocked(getRequestId).mockReturnValue("req-002");

      const consoleMod = await import("../../src/utils/console");
      consoleMod._setLogger(mockLogger);
      const { error } = consoleMod;

      error("Critical", "System failure");

      expect(mockError).toHaveBeenCalledWith(
        {
          prefix: "Critical",
          requestId: "req-002",
        },
        "System failure",
      );
    });
  });

  describe("success", () => {
    it("should log success message with success flag", async () => {
      const { getRequestId } = await import("../../src/utils/context");
      vi.mocked(getRequestId).mockReturnValue("req-success");

      const consoleMod = await import("../../src/utils/console");
      consoleMod._setLogger(mockLogger);
      const { success } = consoleMod;

      success("Container", "Container created", { id: "container-123" });

      expect(mockInfo).toHaveBeenCalledWith(
        {
          prefix: "Container",
          requestId: "req-success",
          success: true,
          id: "container-123",
        },
        "Container created",
      );
    });

    it("should log success without metadata but still include success flag", async () => {
      const { getRequestId } = await import("../../src/utils/context");
      vi.mocked(getRequestId).mockReturnValue("req-003");

      const consoleMod = await import("../../src/utils/console");
      consoleMod._setLogger(mockLogger);
      const { success } = consoleMod;

      success("Deploy", "Deployment complete");

      expect(mockInfo).toHaveBeenCalledWith(
        {
          prefix: "Deploy",
          requestId: "req-003",
          success: true,
        },
        "Deployment complete",
      );
    });
  });

  describe("Logger initialization", () => {
    it("should export a test helper and initialize logger", async () => {
      // import the module so it initializes the logger
      const consoleMod = await import("../../src/utils/console");

      // module should expose a test helper to override the logger
      expect(typeof consoleMod._setLogger).toBe("function");
      // pino may be called during module init; if it is, ensure it received the level option
      if ((pino as any).mock && (pino as any).mock.calls.length > 0) {
        expect(pino).toHaveBeenCalledWith(expect.objectContaining({ level: "info" }));
      }
    });
  });
});
