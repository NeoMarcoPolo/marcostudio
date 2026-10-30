import {fireEvent, render, screen} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {SampleHelp} from "./SampleHelp";
import workflow from "../public/sample-image-check.json";

describe("optional sample", () => {
  it("requires an explicit action to load and never offers to replace an existing source", () => {
    const load = vi.fn();
    const view = render(<SampleHelp imageTool hasSource={false} disabled={false} onLoadSample={load}/>);
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Try a sample"));
    fireEvent.click(screen.getByRole("button", {name: "Use sample image"}));
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(<SampleHelp imageTool hasSource disabled={false} onLoadSample={load}/>);
    expect(screen.queryByRole("button", {name: "Use sample image"})).not.toBeInTheDocument();
    expect(screen.getByText(/will not replace it/)).toBeInTheDocument();
  });

  it("provides a simple image-only workflow and describes its limits", () => {
    render(<SampleHelp imageTool={false} hasSource={false} disabled={false} onLoadSample={vi.fn()}/>);
    fireEvent.click(screen.getByText("Try a sample"));
    expect(screen.getByText(/does not test model inference/)).toBeInTheDocument();
    expect(screen.getByRole("link", {name: "Download sample workflow"})).toHaveAttribute("href", "./sample-image-check.json");
    expect(workflow.nodes.map(node => node.type)).toEqual(["LoadImage", "SaveImage"]);
    expect(workflow.links).toEqual([[1, 1, 0, 2, 0, "IMAGE"]]);
  });
});
