import { ArrowLeftRight, FileCode2, FileText, Layers3, LockKeyhole, Search } from 'lucide-react';
import { formatRevision, snapshots } from '@attuner/shared';
import { Badge } from '../primitives';

export function DiffView({
  from,
  to,
  setFrom,
  setTo,
  file,
  setFile,
  mode,
  setMode,
  query,
  setQuery,
}: {
  from: number;
  to: number;
  setFrom: (n: number) => void;
  setTo: (n: number) => void;
  file: string;
  setFile: (f: string) => void;
  mode: 'split' | 'unified';
  setMode: (v: 'split' | 'unified') => void;
  query: string;
  setQuery: (q: string) => void;
}) {
  const files = ['WeakAuras.lua', 'Plater.lua', 'Bartender4.lua', 'ElvUI.lua'];
  const key =
    file === 'WeakAuras.lua'
      ? 'iconSize'
      : file === 'Plater.lua'
        ? 'nameplateScale'
        : file === 'Bartender4.lua'
          ? 'buttonSize'
          : 'uiScale';
  const value = (revision: number) =>
    file === 'Plater.lua'
      ? (0.7 + (revision - 4887) * 0.1).toFixed(1)
      : file === 'ElvUI.lua'
        ? (0.55 + (revision - 4887) * 0.05).toFixed(2)
        : String(32 + (revision - 4887) * 4);
  const oldValue = value(from);
  const newValue = value(to);
  const same = from === to;
  const lines = [
    `-- ${file} · sample SavedVariables`,
    `DemoProfile = {`,
    `  ["name"] = "Forever",`,
    `  ["display"] = {`,
    `    ["region"] = "icon",`,
    `    ["${key}"] = ${oldValue},`,
    `    ["xOffset"] = 0,`,
    `    ["yOffset"] = -12,`,
    `    ["cooldown"] = true,`,
    `    ["desaturate"] = ${from >= 4892},`,
    `    ["anchorPoint"] = "CENTER",`,
    `  },`,
    `  ["enabled"] = true,`,
    `}`,
  ];
  const updated = lines.map((line, i) =>
    i === 5
      ? line.replace(oldValue, newValue)
      : i === 9
        ? `    ["desaturate"] = ${to >= 4892},`
        : line,
  );
  const changedLines = lines.filter((line, index) => line !== updated[index]).length;
  const renderLine = (line: string, index: number, side?: 'before' | 'after') => {
    if (query && !line.toLowerCase().includes(query.toLowerCase())) return null;
    return (
      <div
        className={`code-line ${side === 'before' ? 'line-removed' : side === 'after' ? 'line-added' : ''}`}
        key={`${index}-${side ?? 'context'}`}
      >
        <span className="line-number">{238 + index}</span>
        <span className="line-marker">{side === 'before' ? '−' : side === 'after' ? '+' : ''}</span>
        <code>
          <Syntax text={line} />
        </code>
      </div>
    );
  };
  const renderLines = (side: 'before' | 'after') =>
    (side === 'before' ? lines : updated).map((line, index) =>
      renderLine(line, index, lines[index] !== updated[index] ? side : undefined),
    );
  const unifiedLines = lines.flatMap((line, index) =>
    line !== updated[index]
      ? [renderLine(line, index, 'before'), renderLine(updated[index]!, index, 'after')]
      : [renderLine(line, index)],
  );
  return (
    <section className="diff-workspace content-panel">
      <div className="diff-toolbar">
        <span className="diff-revision-select">
          <Layers3 size={15} />
          <label>
            <span className="sr-only">Before revision</span>
            <select
              aria-label="Before revision"
              value={from}
              onChange={(e) => setFrom(Number(e.target.value))}
            >
              {[...new Set([from, ...snapshots.map((s) => s.revision)])]
                .sort((a, b) => b - a)
                .map((n) => (
                  <option value={n} key={n}>
                    {formatRevision(n)}
                  </option>
                ))}
            </select>
          </label>
          <button
            className="icon-button"
            aria-label="Swap revisions"
            onClick={() => {
              setFrom(to);
              setTo(from);
            }}
          >
            <ArrowLeftRight size={15} />
          </button>
          <label>
            <span className="sr-only">After revision</span>
            <select
              aria-label="After revision"
              value={to}
              onChange={(e) => setTo(Number(e.target.value))}
            >
              {[...new Set([to, ...snapshots.map((s) => s.revision)])]
                .sort((a, b) => b - a)
                .map((n) => (
                  <option value={n} key={n}>
                    {formatRevision(n)}
                  </option>
                ))}
            </select>
          </label>
        </span>
        <div className="segmented">
          <button aria-pressed={mode === 'split'} onClick={() => setMode('split')}>
            Side by side
          </button>
          <button aria-pressed={mode === 'unified'} onClick={() => setMode('unified')}>
            Unified
          </button>
        </div>
      </div>
      <div className="diff-body">
        <nav className="diff-files" aria-label="Changed files">
          <div className="diff-files-label">
            {same ? 'FILES IN SNAPSHOT' : 'CHANGED FILES'} <span>4</span>
          </div>
          {files.map((f) => (
            <button
              className={file === f ? 'file-selected' : ''}
              onClick={() => setFile(f)}
              key={f}
            >
              <FileCode2 size={15} />
              <span>{f}</span>
              {!same && <span className="file-change-dot" />}
            </button>
          ))}
          <div className="diff-safety">
            <LockKeyhole size={14} />
            <span>
              Read-only fixture.
              <br />
              Lua is never executed.
            </span>
          </div>
        </nav>
        <div className="diff-editor">
          <div className="diff-file-heading">
            <span>
              <FileCode2 size={15} />
              {file}
            </span>
            <label className="diff-search">
              <Search size={14} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search diff"
                placeholder="Find in file…"
              />
            </label>
            <Badge>
              {same ? 'No changes' : `${changedLines} ${changedLines === 1 ? 'change' : 'changes'}`}
            </Badge>
          </div>
          <div
            tabIndex={0}
            role="region"
            aria-label="File comparison, scroll to explore"
            className={`diff-panes ${mode === 'unified' ? 'diff-unified' : ''}`}
          >
            {mode === 'unified' ? (
              <div className="code-pane">
                <div className="code-pane-heading">
                  <span>
                    {formatRevision(from)} → {formatRevision(to)}
                  </span>
                  <span>Unified comparison</span>
                </div>
                {unifiedLines}
              </div>
            ) : (
              <>
                <div className="code-pane">
                  <div className="code-pane-heading">
                    <span className="text-error">− {formatRevision(from)}</span>
                    <span>Before</span>
                  </div>
                  {renderLines('before')}
                </div>
                <div className="code-pane">
                  <div className="code-pane-heading">
                    <span className="text-success">+ {formatRevision(to)}</span>
                    <span>After</span>
                  </div>
                  {renderLines('after')}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="panel-footnote">
        <FileText size={13} />
        Bounded syntax-highlighted fixture comparison. Full Monaco and large-file retrieval arrive
        in Phase 5.
      </div>
    </section>
  );
}
function Syntax({ text }: { text: string }) {
  return (
    <>
      {text.split(/("[^"]*"|\b\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|--.*$)/g).map((part, i) => (
        <span
          key={i}
          className={
            part.startsWith('"')
              ? 'syntax-string'
              : /^(true|false)$/.test(part)
                ? 'syntax-boolean'
                : /^\d/.test(part)
                  ? 'syntax-number'
                  : part.startsWith('--')
                    ? 'syntax-comment'
                    : undefined
          }
        >
          {part}
        </span>
      ))}
    </>
  );
}
