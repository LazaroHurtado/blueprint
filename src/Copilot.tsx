import { useCallback, useEffect, useId, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  cancelCopilot, disconnectCopilot, generatePrompt, getCopilotModels, getCopilotStatus,
  loginCopilot, message, reopenCopilotBrowser, type CopilotModel, type CopilotStatus,
} from "./copilot.ts";
import { Icon } from "./Nodes.tsx";
import { Dialog, Field } from "./ui.tsx";
import { newId, type AgentNode } from "./workflow.ts";

export function useCopilot() {
  const [status, setStatus] = useState<CopilotStatus | null>(null);
  const [models, setModels] = useState<CopilotModel[]>([]);
  const [checking, setChecking] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [error, setError] = useState("");
  const [modelsError, setModelsError] = useState("");
  const [phase, setPhase] = useState<"idle" | "login" | "cancelling" | "disconnecting">("idle");
  const revision = useRef(0);
  const active = useRef<{ id: string; settled: Promise<boolean> } | null>(null);

  const loadModels = useCallback(async (version: number) => {
    setModelsLoading(true);
    setModelsError("");
    try {
      const available = await getCopilotModels();
      if (revision.current === version) setModels(available);
    } catch (problem) {
      if (revision.current === version) { setModels([]); setModelsError(message(problem)); }
    } finally {
      if (revision.current === version) setModelsLoading(false);
    }
  }, []);

  const refresh = useCallback(async (restart = true) => {
    if (!isTauri()) return;
    const version = ++revision.current;
    setChecking(true);
    setError("");
    setModels([]);
    setModelsError("");
    setModelsLoading(false);
    try {
      const current = await getCopilotStatus(restart);
      if (version !== revision.current) return;
      setStatus(current);
      if (current.connected) await loadModels(version);
    } catch (problem) {
      if (version === revision.current) setError(message(problem));
    } finally {
      if (version === revision.current) setChecking(false);
    }
  }, [loadModels]);

  useEffect(() => {
    void refresh(false);
    return () => { revision.current++; };
  }, [refresh]);

  function login() {
    if (active.current) { setError("A Copilot request is still finishing."); return; }
    const version = ++revision.current;
    const id = newId();
    setPhase("login");
    setChecking(false);
    setError("");
    const settled = Promise.resolve().then(async () => {
      try {
        const current = await loginCopilot(id);
        if (current && revision.current === version) {
          setStatus(current);
          setModels([]);
          void loadModels(version);
        }
        return true;
      } catch (problem) {
        if (revision.current === version) setError(message(problem));
        return false;
      } finally {
        active.current = null;
        setPhase("idle");
      }
    });
    active.current = { id, settled };
  }

  async function cancel(): Promise<boolean> {
    const pending = active.current;
    if (!pending) return true;
    setPhase("cancelling");
    try { await cancelCopilot(pending.id); return await pending.settled; }
    catch (problem) { setError(message(problem)); setPhase("login"); return false; }
  }

  async function reopen() {
    if (!active.current) { setError("The sign-in request has finished. Try signing in again."); return; }
    try { await reopenCopilotBrowser(active.current.id); setError(""); }
    catch (problem) { setError(message(problem)); }
  }

  async function disconnect() {
    if (active.current) { setError("Cancel the active Copilot request first."); return; }
    ++revision.current;
    setPhase("disconnecting");
    setChecking(false);
    setError("");
    try {
      setStatus(await disconnectCopilot());
      setModels([]);
      setModelsError("");
      setModelsLoading(false);
    } catch (problem) { setError(message(problem)); }
    finally { setPhase("idle"); }
  }

  return {
    status, models, checking, modelsLoading, error, modelsError, phase,
    login, cancel, reopen, disconnect, refresh,
  };
}

export type CopilotController = ReturnType<typeof useCopilot>;

export function CopilotAccount({ copilot, onOpen, compact = false }: {
  copilot: CopilotController; onOpen: () => void; compact?: boolean;
}) {
  const connected = copilot.status?.connected;
  if (compact) return <div className="copilot-footer">
    <span><i className={`connection-dot ${connected ? "connected" : ""}`} />{connected ? "Copilot connected" : "Copilot not connected"}</span>
    <button className="text-button" onClick={onOpen}>{connected ? "Account" : "Login"}</button>
  </div>;
  return <div className="welcome-copilot">
    {connected ? <div className="copilot-account">
      <i className="connection-dot connected" />
      <div><strong>Copilot connected</strong><small>{copilot.status?.login ? `@${copilot.status.login}` : copilot.status?.host || "GitHub account"}</small></div>
      <button className="text-button" onClick={onOpen}>Account</button>
    </div> : <button className="copilot-login" disabled={copilot.checking} onClick={onOpen}>
      <Icon type="sparkles" />{copilot.checking ? "Checking Copilot..." : "Login with Copilot"}
    </button>}
    <p className="muted">{connected ? <>Generate prompts and browse your models.<br />Editing and export still work offline.</>
      : <>Optional. Generate prompts and browse your models.<br />You can keep editing workflows without signing in.</>}</p>
    {copilot.error && <div className="copilot-status-error"><p className="error" role="alert">{copilot.error}</p><button className="text-button" onClick={() => void copilot.refresh()}>Retry connection</button></div>}
  </div>;
}

export function CopilotDialog({ copilot, onClose }: { copilot: CopilotController; onClose: () => void }) {
  const signingIn = copilot.phase === "login" || copilot.phase === "cancelling";
  const busy = copilot.phase === "cancelling" || copilot.phase === "disconnecting";
  async function close() { if (await copilot.cancel()) onClose(); }
  return <Dialog title={signingIn ? "Finish signing in" : copilot.status?.connected ? "Copilot account" : "Login with Copilot"} className="copilot-dialog" onClose={() => void close()} busy={busy}>
    {signingIn ? <>
      <p className="muted">Continue in your browser, then return to Blueprint.</p>
      <p className="copilot-wait" role="status"><span className="spinner" />{copilot.phase === "cancelling" ? "Cancelling sign-in..." : "Waiting for GitHub..."}</p>
      <p className="muted">A Copilot-enabled GitHub account is required. Your workflow stays available if you cancel.</p>
    </> : copilot.status?.connected ? <>
      <p><i className="connection-dot connected" /> Connected as <strong>{copilot.status.login ? `@${copilot.status.login}` : "your GitHub account"}</strong></p>
      {copilot.status.host && <p className="muted">{copilot.status.host}</p>}
      <p className="muted">Disconnect affects only Blueprint. It does not sign you out of Copilot CLI or remove its credentials.</p>
      <button className="text-button" disabled={busy || copilot.checking} onClick={() => void copilot.refresh()}>{copilot.checking ? "Refreshing..." : "Refresh account and models"}</button>
      {copilot.modelsError && <p className="error" role="alert">{copilot.modelsError}</p>}
    </> : <p className="muted">Sign in through your browser, or reuse an existing Copilot login. Copilot manages credentials; Blueprint never stores tokens in workflow files or browser storage.</p>}
    {copilot.error && <p className="error" role="alert">{copilot.error}</p>}
    <div className="dialog-actions">
      <button disabled={busy} onClick={() => void close()}>{signingIn ? "Cancel" : "Close"}</button>
      {signingIn ? <button disabled={busy} onClick={() => void copilot.reopen()}>Open browser again</button>
        : copilot.status?.connected ? <button disabled={busy || copilot.checking} onClick={() => void copilot.disconnect()}>{busy ? "Disconnecting..." : "Disconnect"}</button>
        : <button className="primary" disabled={copilot.checking} onClick={copilot.login}>Login with Copilot</button>}
    </div>
  </Dialog>;
}

export function ModelField({ agent, copilot, onChange, onManual }: {
  agent: AgentNode; copilot: CopilotController; onChange: (model: string | undefined) => void; onManual: () => void;
}) {
  const selected = copilot.models.find((model) => model.id === agent.model);
  const connected = copilot.status?.connected;
  const hint = !connected ? "Optional. Login to browse models; manual IDs still work."
    : !agent.model ? "Uses Copilot's configured model."
    : selected ? selected.policy || `${selected.id} · Used when the workflow runs.`
    : copilot.modelsLoading ? "Loading models. Your saved ID is kept." : "Not in this account's list. Your saved ID is kept.";
  return <div className="model-field">
    <Field label="Model" hint={hint}>{connected ? <select value={agent.model ? `model:${agent.model}` : ""} onChange={(event) => {
      if (event.target.value === "manual") onManual();
      else onChange(event.target.value ? event.target.value.slice(6) : undefined);
    }}>
      <option value="">Default</option>
      {!!agent.model && !selected && <option value={`model:${agent.model}`}>{agent.model} (saved ID)</option>}
      <optgroup label={copilot.modelsLoading ? "Loading account models..." : "Models for your account"}>
        {copilot.models.map((model) => <option key={model.id} value={`model:${model.id}`} disabled={!model.selectable}>
          {model.name}{!model.selectable ? ` - ${model.policy || "Unavailable"}` : ""}
        </option>)}
      </optgroup>
      <option value="manual">Enter a model ID...</option>
    </select> : <input value={agent.model || ""} maxLength={200} placeholder="Default or model ID" onChange={(event) => onChange(event.target.value.trim() || undefined)} />}</Field>
    {selected?.notices.map((notice, index) => <p className="muted model-notice" key={index}>{notice}</p>)}
    {(copilot.modelsError || copilot.error) && <div className="model-notice"><p className="error" role="alert">{copilot.modelsError || copilot.error}</p><button className="text-button" disabled={copilot.checking} onClick={() => void copilot.refresh()}>Retry connection</button></div>}
  </div>;
}

export function CustomModelDialog({ agent, onSave, onClose }: {
  agent: AgentNode; onSave: (model: string | undefined) => void; onClose: () => void;
}) {
  const [value, setValue] = useState(agent.model || "");
  const [error, setError] = useState("");
  return <Dialog title="Use a model ID" onClose={onClose}>
    <p className="muted">Keep an imported model or enter an exact ID manually.</p>
    <Field label="Model ID"><input value={value} maxLength={200} autoFocus placeholder="Default" onChange={(event) => setValue(event.target.value)} /></Field>
    <p className="muted">IDs outside your model list are kept. Copilot must support the model when the workflow runs. Leave blank to use Default.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="dialog-actions"><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => {
      try { onSave(value.trim() || undefined); } catch (problem) { setError(message(problem)); }
    }}>Use model ID</button></div>
  </Dialog>;
}

export function PromptDialog({ agent, onApply, onClose, onConnect }: {
  agent: AgentNode; onApply: (prompt: string) => void; onClose: () => void; onConnect: () => void;
}) {
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState("");
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<"describe" | "generating" | "preview" | "cancelling">("describe");
  const active = useRef<{ id: string; settled: Promise<boolean> } | null>(null);
  const cancelled = useRef(false);
  const mounted = useRef(true);
  const inputId = useId();
  const busy = phase === "generating" || phase === "cancelling";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (active.current) void cancelCopilot(active.current.id).catch((problem: unknown) => console.error("Could not cancel the closed prompt dialog:", message(problem)));
    };
  }, []);

  function generate() {
    if (active.current) { setError("The previous request is still finishing."); return; }
    const id = newId();
    cancelled.current = false;
    setError("");
    setWarning("");
    setPhase("generating");
    const settled = Promise.resolve().then(async () => {
      try {
        const result = await generatePrompt(id, agent, description);
        if (result && !cancelled.current && mounted.current) {
          setDraft(result.prompt);
          setWarning(result.warning || "");
          setPhase("preview");
        }
        return true;
      } catch (problem) {
        if (mounted.current) setError(message(problem));
        return false;
      } finally {
        active.current = null;
        if (mounted.current) setPhase((current) => current === "generating" || current === "cancelling" ? "describe" : current);
      }
    });
    active.current = { id, settled };
  }

  async function close() {
    const pending = active.current;
    if (!pending) { onClose(); return; }
    cancelled.current = true;
    setPhase("cancelling");
    try {
      await cancelCopilot(pending.id);
      if (await pending.settled) onClose();
    } catch (problem) { setError(message(problem)); setPhase("generating"); }
  }

  return <Dialog title={phase === "preview" ? "Review generated prompt" : "Generate system prompt"}
    className={phase === "preview" ? "prompt-preview" : "prompt-dialog"} onClose={() => void close()} busy={phase === "cancelling"}>
    <p className="muted">{phase === "preview" ? "Nothing changes until you apply this draft." : "Describe the agent. Review the draft before applying it."}</p>
    <span className="agent-context">{agent.name || "Unnamed"} · {phase === "preview" ? "System prompt" : `${agent.output.toUpperCase()} output`}</span>
    {phase === "preview" ? <>
      <Field label="Generated prompt"><textarea rows={14} maxLength={30_000} value={draft} onChange={(event) => setDraft(event.target.value)} /></Field>
      <p className="muted">Applying replaces only this agent's system prompt. Its model, tools and output settings stay the same.</p>
    </> : <>
      <label className="field" htmlFor={inputId}><span>What should this agent do?</span><textarea id={inputId} rows={5} autoFocus disabled={busy} maxLength={10_000}
        value={description} placeholder="Review Python changes for correctness and missing tests. Never edit files."
        onChange={(event) => setDescription(event.target.value)} /></label>
      <div className="draft-model"><span className="muted">Drafting model</span><span>Copilot default</span></div>
      <p className="copilot-privacy">Uses your Copilot allowance. Only your description and this agent's name, tool names and output settings are sent. No repository files or tools are accessed.</p>
      {busy && <p className="copilot-wait" role="status"><span className="spinner" />{phase === "cancelling" ? "Cancelling generation..." : "Generating a draft..."}</p>}
    </>}
    {warning && <p className="error" role="alert">{warning}</p>}
    {error && <div><p className="error" role="alert">{error}</p><button className="text-button" disabled={busy} onClick={onConnect}>Check Copilot connection</button></div>}
    <div className="prompt-actions">
      {phase === "preview" ? <button onClick={() => { setPhase("describe"); setError(""); }}>Edit request</button>
        : <small>Your current prompt stays unchanged until you choose Apply.</small>}
      <div><button disabled={phase === "cancelling"} onClick={() => void close()}>Cancel</button>
        {phase === "preview" ? <button className="primary" disabled={!draft.trim()} onClick={() => {
          try { onApply(draft); } catch (problem) { setError(message(problem)); }
        }}>Apply prompt</button> : <button className="primary" disabled={busy || !description.trim()} onClick={generate}>{busy ? "Generating..." : "Generate prompt"}</button>}</div>
    </div>
  </Dialog>;
}
