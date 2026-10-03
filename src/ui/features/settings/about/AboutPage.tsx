import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DesktopInfo } from '@/core/backend';
import { useSnowdrop } from '@/ui/hooks';
import { SnowdropMark } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { APP_VERSION, LICENCES } from './licences.generated';
import styles from './about.module.css';

/** signal-cli's exact source, from the bundled SOURCE.txt ("Exact source: <url>"). */
function sourceUrl(source: string | null): string | null {
  const match = /^Exact source:\s+(https:\/\/\S+)$/mu.exec(source ?? '');
  return match?.[1] ?? null;
}

function useDesktopInfo(): DesktopInfo | null {
  const { desktop } = useSnowdrop();
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  useEffect(() => {
    let live = true;
    void desktop?.info().then((value) => {
      if (live) setInfo(value);
    });
    return () => {
      live = false;
    };
  }, [desktop]);
  return info;
}

export function AboutPage() {
  const desktop = useDesktopInfo();
  const managed = desktop?.managedSignalCli ?? null;
  // A bundled build has the exact source archive link (SOURCE.txt); a
  // downloaded signal-cli instead links to its own release tag.
  const exactSource = sourceUrl(desktop?.signalCliSource ?? null);
  const bundled = Boolean(desktop?.signalCliLicense);
  const releaseLink = exactSource ?? desktop?.signalCliReleaseUrl ?? null;
  return (
    <>
      <SettingsSection>
        <SettingRow id="about.version" label="Version" stacked>
          <div className={styles.brand}>
            <SnowdropMark size={40} className={styles.mark} />
            <div>
              <p className={styles.name}>Snowdrop {APP_VERSION}</p>
              <p className={styles.muted}>
                A community-style client for Signal, through signal-cli. MIT licence.
              </p>
            </div>
          </div>
        </SettingRow>
      </SettingsSection>
      <SettingsSection
        title="Open-source licences"
        description={
          <>
            Snowdrop is built on these {LICENCES.length} packages (and the packages they use). Thank
            you to their authors. The full licence texts of everything in the app are in{' '}
            <a href="/THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener noreferrer">
              THIRD_PARTY_NOTICES.txt
            </a>{' '}
            (generated with each build).
          </>
        }
      >
        <SettingRow id="about.licences" label="Packages" stacked>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Package</th>
                <th scope="col">Version</th>
                <th scope="col">Licence</th>
              </tr>
            </thead>
            <tbody>
              {LICENCES.map((l) => (
                <tr key={l.name}>
                  <td>
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.link}
                    >
                      {l.name}
                      <ExternalLink size={12} aria-label="(opens in a new tab)" />
                    </a>
                  </td>
                  <td className={styles.version}>{l.version}</td>
                  <td>{l.license}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SettingRow>
      </SettingsSection>
      {desktop && (
        <SettingsSection
          title="signal-cli"
          description={
            bundled
              ? `This app includes signal-cli ${managed}, unmodified, as a separate program that Snowdrop starts and talks to. signal-cli is free software under the GNU General Public License v3.`
              : managed
                ? `Snowdrop downloaded signal-cli ${managed} from its own release the first time it ran, and runs it as a separate program. signal-cli is free software under the GNU General Public License v3.`
                : 'Snowdrop runs the signal-cli you installed, as a separate program.'
          }
        >
          <SettingRow id="about.signalCli" label="signal-cli" stacked>
            <div className={styles.legal}>
              {releaseLink && (
                <p>
                  {exactSource ? 'Source code of this exact version:' : 'Its release page:'}{' '}
                  <a
                    href={releaseLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.link}
                  >
                    {releaseLink}
                    <ExternalLink size={12} aria-label="(opens in your browser)" />
                  </a>
                </p>
              )}
              {desktop.dataDir && (
                <p>
                  Its data (your linked account and keys) is kept in{' '}
                  <code className={styles.path}>{desktop.dataDir}</code>
                  {desktop.logFile && (
                    <>
                      , its log in <code className={styles.path}>{desktop.logFile}</code>
                    </>
                  )}
                  .
                </p>
              )}
              {desktop.signalCliLicense && (
                <details className={styles.licence}>
                  <summary>GNU General Public License v3 (signal-cli)</summary>
                  <pre>{desktop.signalCliLicense}</pre>
                </details>
              )}
            </div>
          </SettingRow>
        </SettingsSection>
      )}
      <SettingsSection title="Legal">
        <SettingRow id="about.legal" label="The fine print" stacked>
          <div className={styles.legal}>
            <p>
              Snowdrop is an independent project. It is not made by, affiliated with or endorsed by
              Signal Messenger LLC or the Signal Technology Foundation. “Signal” is their trademark,
              used here only to describe compatibility.
            </p>
            <p>
              {bundled
                ? 'Snowdrop talks to signal-cli (GPL-3.0), which ships with this app as a separate, unmodified program; none of its code is part of Snowdrop.'
                : managed
                  ? 'Snowdrop talks to signal-cli (GPL-3.0). The first time it runs, Snowdrop downloads it directly from its own authors’ releases and runs it as a separate program on your computer; none of its code is part of Snowdrop.'
                  : 'Snowdrop talks to signal-cli (GPL-3.0), which runs as a separate program on your computer; none of its code is included.'}{' '}
              Inter and JetBrains Mono are used under the SIL Open Font License and bundled locally.
              Icons are from Lucide (ISC).
            </p>
          </div>
        </SettingRow>
      </SettingsSection>
    </>
  );
}
