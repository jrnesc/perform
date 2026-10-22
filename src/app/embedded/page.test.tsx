import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../api/preview/[resource]/route";
import { PerformWorkspace } from "./page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@fanvue/builder-sdk/react", () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => ({ authFetch: vi.fn(), clearJwt: vi.fn() }),
  useEmbeddedAuth: () => ({ status: "authenticated", error: null, theme: "light" }),
}));

const preparedIds: string[] = [];

beforeEach(() => {
  preparedIds.length = 0;
  Element.prototype.scrollIntoView = () => undefined;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const resource = url.replace("/api/preview/", "");
    const context = { params: Promise.resolve({ resource }) };
    if (init?.method !== "POST") return GET(new Request(`http://local${url}`), context);
    preparedIds.push((JSON.parse(String(init.body)) as { id: string }).id);
    return POST(new Request(`http://local${url}`, { method: "POST", body: init.body }), context);
  });
});

describe("Experiment setup", () => {
  it("drops a prepared review when an earlier input changes, and re-prepares under a fresh ID", async () => {
    render(<PerformWorkspace preview />);
    fireEvent.change(screen.getByLabelText("Experiment name"), { target: { value: "Stale review" } });
    fireEvent.click(await screen.findByRole("button", { name: /Fictional active subscribers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: /Fictional Afterglow set/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Review", level: 2 })).not.toBeNull();

    fireEvent.change(screen.getAllByLabelText("Message copy")[0], {
      target: { value: "A rewritten control message." },
    });
    expect(screen.queryByRole("heading", { name: "Review", level: 2 })).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Review", level: 2 })).not.toBeNull();
    expect(screen.getAllByText("A rewritten control message.").length).toBeGreaterThan(0);
    expect(preparedIds).toHaveLength(2);
    expect(preparedIds[1]).not.toBe(preparedIds[0]);
  });

  it("refuses to continue with a price below the minimum", async () => {
    render(<PerformWorkspace preview />);
    fireEvent.change(screen.getByLabelText("Experiment name"), { target: { value: "Cheap" } });
    fireEvent.click(await screen.findByRole("button", { name: /Fictional active subscribers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: /Fictional Afterglow set/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText("Arm A price in US dollars"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Enter a price for Arm A.");
    await waitFor(() => expect(preparedIds).toHaveLength(0));
  });
});
