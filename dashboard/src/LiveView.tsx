import { useState } from "react";
import WorkflowGraph from "./WorkflowGraph";
import ActivityFeed from "./ActivityFeed";
import Broadcast from "./Broadcast";
import AgentStatusRail from "./AgentStatusRail";
import ActivityHeatmap from "./ActivityHeatmap";

/**
 * "What's happening right now."
 *
 * Layout (mobile stacks; desktop unfolds):
 *   1. Workflow graph (hero, full-width)
 *   2. 3-col: agent status rail · broadcast composer · activity feed
 *   3. Activity heatmap (collapsible, full-width)
 *
 * Pulse chart and quick-prompts have been folded into other components
 * (heatmap supersedes pulse; presets live inside Broadcast). Scratchpad
 * lives in its own drawer reachable from anywhere.
 */
export default function LiveView() {
  const [showHeatmap, setShowHeatmap] = useState(false);

  return (
    <div className="space-y-4 sm:space-y-5">
      {/* HERO */}
      <WorkflowGraph />

      {/* 3-column working area */}
      <div className="grid gap-4 sm:gap-5 xl:grid-cols-12">
        <div className="xl:col-span-3 min-w-0 order-2 xl:order-1">
          <AgentStatusRail />
        </div>
        <div className="xl:col-span-6 min-w-0 order-1 xl:order-2">
          <Broadcast />
        </div>
        <div className="xl:col-span-3 min-w-0 order-3">
          <div className="xl:sticky xl:top-20">
            <ActivityFeed />
          </div>
        </div>
      </div>

      {/* History (collapsed by default) */}
      <div className="card p-3">
        <button
          onClick={() => setShowHeatmap((s) => !s)}
          className="w-full flex items-center justify-between text-sm font-semibold tracking-tight text-zinc-200"
        >
          <span>📊 7-day activity heatmap</span>
          <span className="text-zinc-500 text-xs">{showHeatmap ? "hide" : "show"}</span>
        </button>
        {showHeatmap && (
          <div className="mt-3">
            <ActivityHeatmap />
          </div>
        )}
      </div>
    </div>
  );
}
