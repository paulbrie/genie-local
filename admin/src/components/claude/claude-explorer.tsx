"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { LogsPanel } from "./logs-panel";
import { MemoriesPanel } from "./memories-panel";
import { SessionsPanel } from "./sessions-panel";

/**
 * The Claude area: three views over the `~/.claude` data directory —
 * conversation Sessions, raw Logs, and agent Memories.
 */
export function ClaudeExplorer() {
  return (
    <Tabs defaultValue="sessions" className="min-h-0 flex-1">
      <TabsList>
        <TabsTrigger value="sessions">Sessions</TabsTrigger>
        <TabsTrigger value="logs">Logs</TabsTrigger>
        <TabsTrigger value="memories">Memories</TabsTrigger>
      </TabsList>
      <TabsContent value="sessions">
        <SessionsPanel />
      </TabsContent>
      <TabsContent value="logs">
        <LogsPanel />
      </TabsContent>
      <TabsContent value="memories">
        <MemoriesPanel />
      </TabsContent>
    </Tabs>
  );
}
