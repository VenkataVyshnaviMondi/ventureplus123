import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";
import { authApi } from "@/services/api";

vi.mock("@/services/api", () => ({ authApi: { me: vi.fn(), login: vi.fn(), logout: vi.fn(), register: vi.fn() } }));
const user = { id: "fixture-user", email: "synthetic@example.test", fullName: "Synthetic Admin", displayName: "Synthetic", role: "ADMIN" as const };
const response = { success: true, data: { user }, message: "Fixture" };
function Probe() {
  const auth = useAuth();
  return <>
    <span>{auth.loading ? "Loading" : auth.user?.displayName ?? "Signed out"}</span>
    <button onClick={() => { void auth.login(user.email, "fixture-password", undefined, "ADMIN").catch(() => {}); }}>Login</button>
    <button onClick={() => { void auth.logout().catch(() => {}); }}>Logout</button>
  </>;
}
beforeEach(() => { localStorage.clear(); vi.resetAllMocks(); vi.mocked(authApi.me).mockResolvedValue(response); });
afterEach(cleanup);
describe("browser authentication compatibility", () => {
  it("recovers from malformed cached profile data", async () => {
    localStorage.setItem("estatehub_user", "{broken-json");
    render(<AuthProvider><Probe /></AuthProvider>);
    expect(await screen.findByText("Synthetic")).toBeInTheDocument();
  });
  it("forwards the selected role to server authentication", async () => {
    vi.mocked(authApi.login).mockResolvedValue(response);
    render(<AuthProvider><Probe /></AuthProvider>);
    await screen.findByText("Synthetic");
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    await waitFor(() => expect(authApi.login).toHaveBeenCalledWith(user.email, "fixture-password", undefined, "ADMIN"));
  });
  it("clears local identity even when the logout request fails", async () => {
    vi.mocked(authApi.logout).mockRejectedValue(new Error("Fixture network failure"));
    render(<AuthProvider><Probe /></AuthProvider>);
    await screen.findByText("Synthetic");
    fireEvent.click(screen.getByRole("button", { name: "Logout" }));
    expect(await screen.findByText("Signed out")).toBeInTheDocument();
    expect(localStorage.getItem("estatehub_user")).toBeNull();
  });
});
