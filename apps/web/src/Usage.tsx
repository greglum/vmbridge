import { useState } from "react";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { ChartLineData01Icon, Coins01Icon } from "@hugeicons/core-free-icons";
import type { Overview } from "@vmbridge/contracts";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Analytics } from "./Analytics.tsx";
import { Costs, ranges, type Range } from "./Costs.tsx";
import { Page, type Tab } from "./Page.tsx";

export type UsageTab = "costs" | "activity";

const tabs: Tab<UsageTab>[] = [
  { id: "costs", label: "Costs", icon: Coins01Icon },
  { id: "activity", label: "Activity", icon: ChartLineData01Icon },
];

/** Spend and activity over the same range, which stays put when switching tabs. */
export function Usage({ overview }: { overview: Overview }) {
  const [tab, setTab] = useQueryState("tab", parseAsStringLiteral(tabs.map((entry) => entry.id)).withDefault("costs"));
  const [range, setRange] = useState<Range>("month");
  return (
    <Page
      title="Usage"
      wide
      tabs={tabs}
      tab={tab}
      onTab={setTab}
      actions={
        <ButtonGroup>
          {ranges.map((entry) => (
            <Button key={entry.id} variant={range === entry.id ? "secondary" : "outline"} size="lg" className="h-9" onClick={() => setRange(entry.id)}>
              {entry.label}
            </Button>
          ))}
        </ButtonGroup>
      }
    >
      {tab === "costs" && <Costs overview={overview} range={range} />}
      {tab === "activity" && <Analytics overview={overview} range={range} />}
    </Page>
  );
}
