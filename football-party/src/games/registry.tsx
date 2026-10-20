import type { ComponentType } from 'react';
import type { GameId } from '@shared/games/types';
import { IMPOSTOR_CATEGORY_LABELS } from '@shared/football';
import { maxImpostors, type ImpostorConfig } from '@shared/games/impostor';
import type { TttConfig } from '@shared/games/tictactoe';
import type { RoomController } from '@/lib/room-controller';
import { Segmented, Stepper } from '@/ui/kit';
import { gameMeta, type GameMeta } from './meta';
import { ImpostorScreen } from './impostor/ImpostorScreen';
import { TicTacToeScreen } from './tictactoe/TicTacToeScreen';
import { QuickScreen } from './quick/QuickScreen';
import { WhoAreYaScreen } from './whoareya/WhoAreYaScreen';
import type { WhoAreYaConfig } from '@shared/games/whoareya';
import type { QuickConfig } from '@shared/games/quick';

export interface ConfigProps<C> {
  config: C;
  onChange: (patch: Partial<C>) => void;
  disabled: boolean;
  playerCount: number;
}

export interface ClientGame extends GameMeta {
  Screen: ComponentType<{ ctl: RoomController }>;
  // Config shape differs per game; the lobby passes the server-validated config through unchanged.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Config: ComponentType<ConfigProps<any>>;
}

function ImpostorConfigPanel({
  config,
  onChange,
  disabled,
  playerCount,
}: ConfigProps<ImpostorConfig>) {
  const cap = Math.min(3, maxImpostors(Math.max(playerCount, 3)));
  return (
    <>
      <div className="config-grid">
        <Stepper
          label="Impostors"
          value={Math.min(config.impostors, cap)}
          min={1}
          max={cap}
          onChange={(v) => onChange({ impostors: v })}
          disabled={disabled}
        />
        <Stepper
          label="Rounds"
          value={config.rounds}
          min={1}
          max={8}
          onChange={(v) => onChange({ rounds: v })}
          disabled={disabled}
        />
        <div className="field span-2">
          <label htmlFor="cat">Category</label>
          <select
            id="cat"
            className="input"
            value={config.category}
            disabled={disabled}
            onChange={(e) => onChange({ category: e.target.value as ImpostorConfig['category'] })}
          >
            {Object.entries(IMPOSTOR_CATEGORY_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="span-2">
          <Segmented
            label="Footballers: only the most famous…"
            value={config.difficulty}
            disabled={disabled}
            onChange={(v) => onChange({ difficulty: v })}
            options={[
              { value: 'easy', label: 'Top 100' },
              { value: 'medium', label: 'Top 250' },
              { value: 'hard', label: 'Top 400' },
            ]}
          />
        </div>
        <div className="span-2">
          <Segmented
            label="Timers"
            value={config.timers ? 'on' : 'off'}
            disabled={disabled}
            onChange={(v) => onChange({ timers: v === 'on' })}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off — take your time' },
            ]}
          />
        </div>
      </div>
      <details className="advanced">
        <summary>Advanced: timers &amp; hints</summary>
        <div className="config-grid">
          <Stepper
            label="Clue laps"
            value={config.clueRounds}
            min={1}
            max={3}
            onChange={(v) => onChange({ clueRounds: v })}
            disabled={disabled}
          />
          <Stepper
            label="Clue timer"
            value={config.clueSeconds}
            min={10}
            max={90}
            step={5}
            suffix="s"
            onChange={(v) => onChange({ clueSeconds: v })}
            disabled={disabled}
          />
          <Stepper
            label="Discussion"
            value={config.discussionSeconds}
            min={15}
            max={300}
            step={15}
            suffix="s"
            onChange={(v) => onChange({ discussionSeconds: v })}
            disabled={disabled}
          />
          <Stepper
            label="Voting timer"
            value={config.voteSeconds}
            min={10}
            max={120}
            step={5}
            suffix="s"
            onChange={(v) => onChange({ voteSeconds: v })}
            disabled={disabled}
          />
          <div className="span-2">
            <Segmented
              label="Impostor gets…"
              value={config.impostorHint}
              disabled={disabled}
              onChange={(v) => onChange({ impostorHint: v })}
              options={[
                { value: 'none', label: 'No hint' },
                { value: 'position', label: 'Position' },
                { value: 'era', label: 'Birth decade' },
              ]}
            />
          </div>
        </div>
      </details>
    </>
  );
}

function TttConfigPanel({ config, onChange, disabled }: ConfigProps<TttConfig>) {
  return (
    <div className="config-grid">
      <div className="span-2">
        <Segmented
          label="Difficulty"
          value={config.difficulty}
          disabled={disabled}
          onChange={(v) => onChange({ difficulty: v })}
          options={[
            { value: 'easy', label: 'Easy · many answers' },
            { value: 'medium', label: 'Medium' },
            { value: 'hard', label: 'Hard · few answers' },
          ]}
        />
      </div>
      <div className="span-2">
        <Segmented
          label="Rounds"
          value={config.rounds}
          disabled={disabled}
          onChange={(v) => onChange({ rounds: v })}
          options={[
            { value: 1, label: 'Single' },
            { value: 3, label: 'Best of 3' },
            { value: 5, label: 'Best of 5' },
          ]}
        />
      </div>
      <div className="span-2">
        <Segmented
          label="Turn timer"
          value={!config.timers ? 'off' : config.turnSeconds}
          disabled={disabled}
          onChange={(v) =>
            v === 'off'
              ? onChange({ timers: false })
              : onChange({ timers: true, turnSeconds: Number(v) })
          }
          options={[
            { value: 'off', label: 'Off' },
            { value: 20, label: '20s' },
            { value: 30, label: '30s' },
            { value: 45, label: '45s' },
            { value: 60, label: '60s' },
            { value: 120, label: '2 min' },
          ]}
        />
      </div>
    </div>
  );
}

function QuickConfigPanel({ config, onChange, disabled }: ConfigProps<QuickConfig>) {
  return (
    <div className="config-grid">
      <div className="span-2">
        <Segmented
          label="Difficulty"
          value={config.difficulty}
          disabled={disabled}
          onChange={(v) => onChange({ difficulty: v })}
          options={[
            { value: 'easy', label: 'Easy' },
            { value: 'medium', label: 'Medium' },
            { value: 'hard', label: 'Hard' },
          ]}
        />
      </div>
      <div className="span-2">
        <Segmented
          label="Rounds"
          value={config.rounds}
          disabled={disabled}
          onChange={(v) => onChange({ rounds: v })}
          options={[
            { value: 5, label: '5' },
            { value: 10, label: '10' },
            { value: 15, label: '15' },
          ]}
        />
      </div>
      <div className="span-2">
        <Segmented
          label="Time per round"
          value={!config.timers ? 'off' : config.seconds}
          disabled={disabled}
          onChange={(v) =>
            v === 'off'
              ? onChange({ timers: false })
              : onChange({ timers: true, seconds: Number(v) })
          }
          options={[
            { value: 'off', label: 'Off' },
            { value: 10, label: '10s' },
            { value: 20, label: '20s' },
            { value: 30, label: '30s' },
            { value: 60, label: '60s' },
          ]}
        />
      </div>
    </div>
  );
}

function WhoAreYaConfigPanel({ config, onChange, disabled }: ConfigProps<WhoAreYaConfig>) {
  return (
    <div className="config-grid">
      <div className="span-2">
        <Segmented
          label="Footballers"
          value={config.difficulty}
          disabled={disabled}
          onChange={(v) => onChange({ difficulty: v })}
          options={[
            { value: 'easy', label: 'Top 100' },
            { value: 'medium', label: 'Top 250' },
            { value: 'hard', label: 'Top 400' },
          ]}
        />
      </div>
      <div className="span-2">
        <Segmented
          label="Rounds"
          value={config.rounds}
          disabled={disabled}
          onChange={(v) => onChange({ rounds: v })}
          options={[
            { value: 3, label: '3' },
            { value: 5, label: '5' },
            { value: 8, label: '8' },
          ]}
        />
      </div>
      <div className="span-2">
        <Segmented
          label="Time per guess"
          value={!config.timers ? 'off' : config.seconds}
          disabled={disabled}
          onChange={(v) =>
            v === 'off'
              ? onChange({ timers: false })
              : onChange({ timers: true, seconds: Number(v) })
          }
          options={[
            { value: 'off', label: 'Off' },
            { value: 30, label: '30s' },
            { value: 60, label: '60s' },
          ]}
        />
      </div>
    </div>
  );
}

export const clientGames: Record<GameId, ClientGame> = {
  impostor: {
    ...gameMeta.impostor,
    Screen: ImpostorScreen,
    Config: ImpostorConfigPanel,
  },
  tictactoe: {
    ...gameMeta.tictactoe,
    Screen: TicTacToeScreen,
    Config: TttConfigPanel,
  },
  linkup: { ...gameMeta.linkup, Screen: QuickScreen, Config: QuickConfigPanel },
  career: { ...gameMeta.career, Screen: QuickScreen, Config: QuickConfigPanel },
  oddone: { ...gameMeta.oddone, Screen: QuickScreen, Config: QuickConfigPanel },
  whoareya: { ...gameMeta.whoareya, Screen: WhoAreYaScreen, Config: WhoAreYaConfigPanel },
};

export const clientGameList = Object.values(clientGames);
