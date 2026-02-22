import { beforeAll, afterAll, afterEach, vi } from "vitest";

// Global test setup
beforeAll(() => {});

afterAll(() => {});

afterEach(() => {
  // Reset mocks after every test
  vi.resetAllMocks();
});

// Keep console util unmocked here so its own unit tests can import the real implementation.
// Individual handler tests may mock the console util when they need to silence logs.

// Set test environment variables
process.env.NODE_ENV = "test";
process.env.CORE_URL = "http://localhost:3000";
process.env.SECRET_KEY = "a".repeat(64);
