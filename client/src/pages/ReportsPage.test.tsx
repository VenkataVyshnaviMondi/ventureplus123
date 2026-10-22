import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import ReportsPage from "./ReportsPage";
import { leadApi } from "@/services/api";

vi.mock("@/services/api", () => ({ leadApi: { list: vi.fn() } }));
vi.mock("@/components/CreateLeadDialog", () => ({ default: () => null }));
vi.mock("@/components/CustomerDetailModal", () => ({ default: ({ customer, open }) => open ?
  <div role="dialog" aria-label="Customer detail"><output data-testid="modal-notes">{JSON.stringify(customer.notes)}</output></div> : null }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it.each([undefined, null, "Existing synthetic notes"])("passes a string to the modal when API notes are %s", async notes => {
  vi.mocked(leadApi.list).mockResolvedValue({ success: true, message: "Fixture", data: [{
    id: "fixture-lead", plotId: "fixture-plot", customerName: "Synthetic Lead", email: "synthetic@example.test",
    contactNumber: "1234567890", location: "Synthetic Location", uniqueId: "fixture-identity", pricePerSqYard: 100,
    notes, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  }] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    render(<QueryClientProvider client={client}><ReportsPage /></QueryClientProvider>);
    const name = await screen.findByText("Synthetic Lead");
    fireEvent.click(within(name.closest("tr")!).getByRole("button"));
    expect(await screen.findByRole("dialog", { name: "Customer detail" })).toBeInTheDocument();
    expect(screen.getByTestId("modal-notes")).toHaveTextContent(JSON.stringify(notes ?? ""));
  } finally { cleanup(); client.clear(); }
});
