import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Notifications, useNotifications } from "./Notifications";

function Harness() {
  const {notices, notify, dismiss, announced} = useNotifications();
  return <><button onClick={() => { for (let i = 1; i <= 4; i++) notify(`Task ${i} failed`, true); }}>Make failures</button>
    <Notifications notices={notices} dismiss={dismiss} announced={announced}/></>;
}

it("keeps failures accessible across a bounded display and allows dismissal", async () => {
  const user = userEvent.setup(); render(<Harness/>);
  await user.click(screen.getByRole("button", {name: "Make failures"}));
  expect(screen.getByLabelText("Urgent notifications")).toHaveTextContent("Task 1 failed");
  expect(screen.getByText("Task 1 failed", {selector: "span"})).toBeInTheDocument();
  expect(screen.getByText("1 more notifications")).toBeInTheDocument();
  await user.click(screen.getAllByRole("button", {name: "Dismiss notification"})[0]);
  expect(screen.getByText("Task 4 failed")).toBeInTheDocument();
  expect(screen.queryByText("Task 1 failed", {selector: "span"})).not.toBeInTheDocument();
});

it("announces a new event during a layer change without reannouncing existing notices", () => {
  function LayerHarness() {
    const {notices, notify, dismiss, announced} = useNotifications();
    const [layer, setLayer] = useState(false);
    return <><button onClick={() => {notify("Connected", false); setLayer(value => !value);}}>Connect</button>
      <button onClick={() => setLayer(value => !value)}>Change layer</button>
      <Notifications key={String(layer)} notices={notices} dismiss={dismiss} announced={announced}/></>;
  }
  render(<LayerHarness/>);
  fireEvent.click(screen.getByRole("button", {name: "Connect"}));
  expect(screen.getByRole("status")).toHaveTextContent("Connected");
  fireEvent.click(screen.getByRole("button", {name: "Change layer"}));
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  expect(screen.getByText("Connected", {selector: "span"})).toBeInTheDocument();
});

it("does not expire a success while it is hidden behind persistent failures", () => {
  vi.useFakeTimers();
  function HiddenHarness() {
    const {notices, notify, dismiss, announced} = useNotifications();
    return <><button onClick={() => {for (let i = 0; i < 3; i++) notify(`Failure ${i}`, true); notify("Done", false);}}>Queue</button>
      <Notifications notices={notices} dismiss={dismiss} announced={announced}/></>;
  }
  const view = render(<HiddenHarness/>);
  fireEvent.click(screen.getByRole("button", {name: "Queue"}));
  act(() => vi.advanceTimersByTime(9000));
  expect(screen.getByText("1 more notifications")).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", {name: "Dismiss notification"})[0]);
  expect(screen.getByText("Done", {selector: ".notification > span"})).toBeInTheDocument();
  view.unmount(); vi.useRealTimers();
});
