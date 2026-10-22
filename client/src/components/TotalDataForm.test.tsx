import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TotalDataForm from "./TotalDataForm";
import { customerApi } from "@/services/api";

vi.mock("@/services/api", () => ({ customerApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const record = { id: "fixture-record", contactName: "Synthetic Contact", contactNumber: "1234567890",
  location: "Synthetic Location", budget: "100", interested: false, recordOwner: "John Employee",
  notes: undefined, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
const response = (data = [record], page = 1, pageCount = 1) => ({ success: true, data, message: "Fixture",
  pagination: { page, pageSize: 100, pageCount, total: pageCount } });

beforeEach(() => { vi.resetAllMocks(); vi.mocked(customerApi.list).mockResolvedValue(response()); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("loads every API page rather than silently truncating the total-data list", async () => {
  const second = { ...record, id: "second-record", contactName: "Second Contact" };
  vi.mocked(customerApi.list).mockImplementation(async page => response(page === 1 ? [record] : [second], page, 2));
  render(<TotalDataForm />);
  expect(await screen.findByText("Second Contact")).toBeInTheDocument();
  expect(screen.getByText("Synthetic Contact")).toBeInTheDocument();
  expect(customerApi.list).toHaveBeenNthCalledWith(1, 1, 100);
  expect(customerApi.list).toHaveBeenNthCalledWith(2, 2, 100);
});

it("edits an existing record through customerApi and normalizes missing notes", async () => {
  render(<TotalDataForm />);
  const name = await screen.findByText("Synthetic Contact");
  fireEvent.click(within(name.closest("tr")!).getAllByRole("button")[0]);
  const notes = screen.getByPlaceholderText("Enter additional notes...");
  expect(notes).toHaveValue("");
  fireEvent.change(notes, { target: { value: "Updated synthetic notes" } });
  fireEvent.click(screen.getByRole("button", { name: "Update" }));
  await waitFor(() => expect(customerApi.update).toHaveBeenCalledWith(record.id, expect.objectContaining({
    contactName: record.contactName, notes: "Updated synthetic notes"
  })));
  expect(customerApi.create).not.toHaveBeenCalled();
});

it("uses the current delete API only after confirmation", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<TotalDataForm />);
  const name = await screen.findByText("Synthetic Contact");
  const remove = within(name.closest("tr")!).getAllByRole("button")[1];
  fireEvent.click(remove);
  expect(customerApi.remove).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(remove);
  await waitFor(() => expect(customerApi.remove).toHaveBeenCalledWith(record.id));
});
