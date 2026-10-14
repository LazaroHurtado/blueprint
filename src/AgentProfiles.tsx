import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { discoverAgents, matchesAgentProfile, type AgentCatalogue, type AgentProfile } from "./agents.ts";
import { message } from "./copilot.ts";
import { Field } from "./ui.tsx";
import type { AgentNode } from "./workflow.ts";

export function AgentProfileField({ agent, folder, selectedId, onSelect, onChooseFolder }: {
  agent: AgentNode; folder: string; selectedId: string; onSelect: (profile: AgentProfile | null) => void; onChooseFolder: () => void;
}) {
  const [catalogue, setCatalogue] = useState<AgentCatalogue>({ profiles: [], issues: [] });
  const [loading, setLoading] = useState(isTauri());
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!isTauri()) return;
    let stopped = false;
    setLoading(true);
    setError("");
    setCatalogue({ profiles: [], issues: [] });
    discoverAgents(folder).then((result) => {
      if (!stopped) setCatalogue(result);
    }).catch((problem: unknown) => {
      if (!stopped) setError(message(problem));
    }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [folder, revision]);
  const selected = catalogue.profiles.find((profile) => profile.id === selectedId && matchesAgentProfile(agent, profile));
  return <>
    <Field label="Agent profile">
      <select aria-label="Agent profile" value={selected?.id || ""} disabled={loading} onChange={(event) => {
        const profile = catalogue.profiles.find((item) => item.id === event.target.value);
        onSelect(profile || null);
      }}>
        <option value="">Custom agent</option>
        {(["project", "personal"] as const).map((source) => <optgroup key={source} label={source === "project"
          ? "Project · .github/agents/" : "Personal · ~/.copilot/agents/"}>
          {catalogue.profiles.filter((profile) => profile.source === source).map((profile) => (
            <option value={profile.id} key={profile.id}>{profile.name} — {profile.fileName}</option>
          ))}
        </optgroup>)}
      </select>
      <small>{!isTauri() ? "Profile discovery requires the desktop app."
        : loading ? "Loading available profiles..."
        : selected ? "Imported copy; original unchanged."
        : catalogue.profiles.length ? "Project + personal agent profiles."
        : error || catalogue.issues.length ? "Profiles could not all be loaded. Custom editing remains available."
        : "No profiles found. Use Custom agent."}</small>
    </Field>
    {error && <p className="error" role="alert">{error}</p>}
    {catalogue.issues.length > 0 && <details className="problems">
      <summary>{catalogue.issues.length} profile {catalogue.issues.length === 1 ? "issue" : "issues"}</summary>
      <ul>{catalogue.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
    </details>}
    {isTauri() && <div>
      {!folder && <button className="text-button" disabled={loading} onClick={onChooseFolder}>Choose project folder</button>}
      <button className="text-button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>{error || catalogue.issues.length ? "Retry profiles" : "Refresh profiles"}</button>
    </div>}
  </>;
}
