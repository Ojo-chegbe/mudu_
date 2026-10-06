import { useEffect, useState } from 'react';
import type { LocalDeliveryStatus } from '../../packages/contracts/local-delivery.ts';
import { api, errorMessage } from './api.ts';
import { Icon, Loading, Notice, Dialog } from './ui.tsx';

export function useCandidateOrigin(preferPublic = false) {
  const [origin, setOrigin] = useState(location.origin);
  useEffect(() => {
    let alive = true;
    async function refresh() {
      try {
        const value = await api<{ origin: string | null }>(
          `/candidate-address${preferPublic ? '?purpose=roster' : ''}`,
        );
        if (alive) setOrigin(value.origin ?? location.origin);
      } catch {
        /* Existing loopback link stays visibly local if the Host is unreachable. */
      }
    }
    void refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [preferPublic]);
  return origin;
}

export function LocalDeliveryPage() {
  const [status, setStatus] = useState<LocalDeliveryStatus | null>(null);
  const [address, setAddress] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  useEffect(() => {
    let alive = true;
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const value = await api<LocalDeliveryStatus>('/local-delivery');
        if (alive) {
          setStatus(value);
          setAddress((current) =>
            value.addresses.some((item) => item.address === current)
              ? current
              : value.addresses.length === 1
                ? value.addresses[0].address
                : '',
          );
        }
      } catch (e) {
        if (alive) setError(errorMessage(e));
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  async function change(stop = false) {
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      setStatus(
        await api<LocalDeliveryStatus>(stop ? '/local-delivery/stop' : '/local-delivery', {
          method: 'POST',
          body: stop ? {} : { address, acknowledged },
        }),
      );
      setConfirmStop(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const link = status?.origin ? `${status.origin}/exam` : '';
  return (
    <div className="local-delivery-page">
      <div className="page-heading">
        <div>
          <h1>Local delivery</h1>
          <p className="muted">One router. Your candidates. No internet required.</p>
        </div>
      </div>
      {error && <Notice>{error}</Notice>}
      {status?.error && <Notice>{status.error}</Notice>}
      {!status ? (
        !error && <Loading />
      ) : (
        <>
          <section className="panel local-connect" aria-labelledby="local-connect-title">
            <span className="eyebrow">
              {status.running ? 'CONNECT CANDIDATES' : 'EXAMINATION NETWORK'}
            </span>
            <h2 id="local-connect-title">
              {status.running ? 'Share this address' : 'Connect your examination room'}
            </h2>
            {status.running ? (
              <>
                <p className="muted">
                  Ask candidates to join the same Wi-Fi, then open this address in their browser.
                </p>
                {link && (
                  <div className="local-address-row">
                    <input
                      aria-label="Candidate address"
                      readOnly
                      value={link}
                      onFocus={(event) => event.target.select()}
                    />
                    <button
                      className="button primary"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(link);
                          setCopied(true);
                        } catch {
                          setError('Select the address and copy it manually.');
                        }
                      }}
                    >
                      {copied ? 'Copied' : 'Copy address'}
                    </button>
                  </div>
                )}
                <div className="local-connection-state" role="status">
                  <Icon name={status.checkedDevices ? 'check' : 'people'} />
                  <div>
                    <strong>
                      {status.checkedDevices ? 'Connection received' : 'Waiting for a device'}
                    </strong>
                    <p className="muted small">
                      {status.checkedDevices
                        ? `${status.checkedDevices} network address${status.checkedDevices === 1 ? '' : 'es'} seen in the last two minutes. Candidate progress appears in each assessment.`
                        : 'Open the address on another phone or laptop to check the connection.'}
                    </p>
                  </div>
                </div>
                <a className="button secondary" href="/">
                  Go to assessments <Icon name="arrow" size={16} />
                </a>
                <p className="field-hint">
                  For a prepared local run, candidates open their saved examination access file
                  here. Save the files from their accounts before disconnecting the internet.
                </p>
              </>
            ) : (
              <>
                <p className="muted">
                  Connect this computer to your router by Wi-Fi or Ethernet. Keep the router on,
                  even when the internet is off.
                </p>
                {!status.addresses.length ? (
                  <Notice kind="info">
                    No local network found. Connect to your router. This screen will update
                    automatically.
                  </Notice>
                ) : (
                  <>
                    {status.addresses.length === 1 ? (
                      <div className="local-network-choice">
                        <Icon name="server" />
                        <div>
                          <strong>{status.addresses[0].name}</strong>
                          <p className="muted small">{status.addresses[0].address}</p>
                        </div>
                      </div>
                    ) : (
                      <label>
                        Examination network
                        <select
                          value={address}
                          onChange={(event) => setAddress(event.target.value)}
                        >
                          <option value="">Choose the connection to your router</option>
                          {status.addresses.map((item) => (
                            <option key={`${item.name}-${item.address}`} value={item.address}>
                              {item.name} · {item.address}
                            </option>
                          ))}
                        </select>
                        <span className="field-hint">
                          Choose your Wi-Fi or Ethernet connection, not a VPN or virtual adapter.
                        </span>
                      </label>
                    )}
                    <label className="local-consent">
                      <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(event) => setAcknowledged(event.target.checked)}
                      />
                      <span>
                        I understand that HTTP does not encrypt passwords or answers. I will use a
                        controlled examination network, not public Wi-Fi.
                      </span>
                    </label>
                    <button
                      className="button primary"
                      disabled={busy || !address || !acknowledged}
                      onClick={() => change()}
                    >
                      {busy ? 'Starting…' : 'Start local delivery'}
                    </button>
                  </>
                )}
              </>
            )}
          </section>
          <div className="local-footnote">
            <Icon name="server" size={16} />
            <span>
              Answers stay on this computer. Keep it powered on and prevent sleep during
              examinations.
            </span>
          </div>
          <details className="panel local-help">
            <summary>A device cannot connect?</summary>
            <ol>
              <li>Join the same router’s Wi-Fi. Avoid the guest network and turn off VPNs.</li>
              <li>
                Type the complete address, including <strong>http://</strong> and{' '}
                <strong>:4311</strong>. A browser “Not secure” label is expected with HTTP.
              </li>
              <li>
                If the phone reports no internet, choose to stay connected. Turn off mobile data
                when testing offline operation.
              </li>
              <li>
                On a trusted Windows network, use the Private network profile and allow the Host
                through the firewall on that profile. Do not disable the firewall.
              </li>
              <li>
                If devices still cannot connect, ask your network administrator to check client
                isolation and inbound TCP port 4311. Do not enable internet port forwarding.
              </li>
            </ol>
            <p className="muted small">
              A successful device connection confirms reachability, not room capacity or that the
              internet has been disconnected.
            </p>
          </details>
          {status.running && (
            <button className="text-button local-stop" onClick={() => setConfirmStop(true)}>
              Stop local delivery
            </button>
          )}
        </>
      )}
      {confirmStop && (
        <Dialog
          title="Stop local delivery?"
          onClose={() => setConfirmStop(false)}
          confirm={() => change(true)}
          confirmLabel="Stop delivery"
          busy={busy}
          danger
        >
          {error && <Notice>{error}</Notice>}
          <p>
            Candidates will no longer be able to connect. Saved answers remain on this computer.
            Active examinations must finish first.
          </p>
        </Dialog>
      )}
    </div>
  );
}
