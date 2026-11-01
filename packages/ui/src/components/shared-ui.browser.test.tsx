import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { NuqsTestingAdapter, type UrlUpdateEvent } from "nuqs/adapters/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DataTableFilterList } from "./data-table/data-table-filter-list.js";
import { DataTableFilterMenu } from "./data-table/data-table-filter-menu.js";
import { TimelineIndicator } from "./timeline.js";

type Person = { name: string };
const data: Person[] = [{ name: "Ada" }];
const columns: ColumnDef<Person>[] = [
  {
    accessorKey: "name",
    enableColumnFilter: true,
    meta: { label: "Name", variant: "text" },
  },
];
const missingColumns: ColumnDef<Person>[] = [];
const initialSearchParams = new URLSearchParams({
  filters: JSON.stringify([
    {
      id: "name",
      value: "Ada",
      variant: "text",
      operator: "iLike",
      filterId: "filter-name",
    },
  ]),
});

function Filters({
  available,
  layout,
}: {
  available: boolean;
  layout: "list" | "menu";
}) {
  const fullTable = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });
  const missingTable = useReactTable({
    data,
    columns: missingColumns,
    getCoreRowModel: getCoreRowModel(),
  });
  const Component = layout === "list" ? DataTableFilterList : DataTableFilterMenu;
  return (
    <Component table={available ? fullTable : missingTable} debounceMs={0} />
  );
}

let host: HTMLDivElement;
let root: Root;
async function flush() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("shared UI mounted behavior", () => {
  it.each(["list", "menu"] as const)(
    "%s retains a filter across unavailable-column transitions and its keyboard removal contract",
    async (layout) => {
      const updates: UrlUpdateEvent[] = [];
      async function render(available: boolean) {
        await act(async () => {
          root.render(
            <NuqsTestingAdapter
              searchParams={initialSearchParams}
              hasMemory
              onUrlUpdate={(event) => updates.push(event)}
            >
              <Filters available={available} layout={layout} />
            </NuqsTestingAdapter>,
          );
          await flush();
        });
      }
      const findFilter = () =>
        document.querySelector<HTMLDivElement>(
          '[role="listitem"][id$="-filter-filter-name"]',
        );

      await render(true);
      if (layout === "list") {
        await act(async () => {
          host.querySelector("button")!.click();
          await flush();
        });
      }
      expect(findFilter()).not.toBeNull();
      await render(false);
      expect(findFilter()).toBeNull();
      expect(updates).toHaveLength(0);
      await render(true);
      const item = findFilter();
      expect(item).not.toBeNull();
      const input = item!.querySelector("input");
      expect(input?.value).toBe("Ada");

      await act(async () => {
        input!.focus();
        input!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
        );
        await flush();
      });
      expect(findFilter()).toBe(item);
      expect(updates).toHaveLength(0);

      await act(async () => {
        item!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
        );
        await flush();
      });
      expect(findFilter()).toBeNull();
      expect(updates.at(-1)?.searchParams.has("filters")).toBe(false);
      expect(document.activeElement?.textContent).toBe(
        layout === "list" ? "Add filter" : "Filter",
      );
    },
  );

  it("slots a timeline indicator onto its child without an extra wrapper or lost interactions", async () => {
    const clicks: string[] = [];
    const childRef = React.createRef<HTMLButtonElement>();
    await act(async () => {
      root.render(
        <TimelineIndicator
          asChild
          id="step-indicator"
          className="indicator-class"
          aria-hidden={false}
          onClick={() => clicks.push("indicator")}
        >
          <button
            ref={childRef}
            type="button"
            className="child-class"
            aria-label="Current step"
            onClick={() => clicks.push("child")}
          >
            Step 1
          </button>
        </TimelineIndicator>,
      );
    });
    const button = host.querySelector("button");
    expect(host.firstElementChild).toBe(button);
    expect(childRef.current).toBe(button);
    expect(button?.id).toBe("step-indicator");
    expect(button?.dataset.slot).toBe("timeline-indicator");
    expect(button?.classList.contains("indicator-class")).toBe(true);
    expect(button?.classList.contains("child-class")).toBe(true);
    expect(button?.getAttribute("aria-hidden")).toBe("false");
    expect(button?.getAttribute("aria-label")).toBe("Current step");
    await act(async () => button!.click());
    expect(clicks).toEqual(["child", "indicator"]);
  });
});
