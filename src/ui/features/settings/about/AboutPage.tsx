import { ExternalLink } from 'lucide-react';
import { ShrikeMark } from '@/ui/primitives';
import { SettingRow } from '../rows/SettingRow';
import { SettingsSection } from '../rows/SettingsSection';
import { APP_VERSION, LICENCES } from './licences.generated';
import styles from './about.module.css';

export function AboutPage() {
  return (
    <>
      <SettingsSection>
        <SettingRow id="about.version" label="Version" stacked>
          <div className={styles.brand}>
            <ShrikeMark size={40} className={styles.mark} />
            <div>
              <p className={styles.name}>Shrike {APP_VERSION}</p>
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
            Shrike is built on these {LICENCES.length} packages (and the packages they use). Thank
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
      <SettingsSection title="Legal">
        <SettingRow id="about.legal" label="The fine print" stacked>
          <div className={styles.legal}>
            <p>
              Shrike is an independent project. It is not made by, affiliated with or endorsed by
              Signal Messenger LLC or the Signal Technology Foundation. “Signal” is their trademark,
              used here only to describe compatibility.
            </p>
            <p>
              Shrike talks to signal-cli (GPL-3.0), which runs as a separate program on your
              computer; none of its code is included. Inter and JetBrains Mono are used under the
              SIL Open Font License and bundled locally. Icons are from Lucide (ISC).
            </p>
          </div>
        </SettingRow>
      </SettingsSection>
    </>
  );
}
