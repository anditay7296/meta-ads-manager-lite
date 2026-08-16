type Props = {
  module: string;
  phase: string;
  goal: string;
  bullets: string[];
};

export function PagePlaceholder({ module, phase, goal, bullets }: Props) {
  return (
    <div className="flex flex-1 flex-col items-start gap-6 p-8">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">
          {phase}
        </span>
        <h2 className="text-xl font-semibold">{module}</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{goal}</p>
      </div>
      <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-6 dark:border-zinc-700 dark:bg-zinc-900">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Planned in this phase
        </h3>
        <ul className="space-y-1.5 text-sm text-zinc-700 dark:text-zinc-300">
          {bullets.map((b) => (
            <li key={b} className="flex gap-2">
              <span className="text-zinc-400">·</span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
