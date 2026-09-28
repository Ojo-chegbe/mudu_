# Local router delivery (HTTP)

Start the built Host normally, sign in on the Host computer, then open **Local delivery**.
Connect to the examination router, select its interface if several are detected, acknowledge
the HTTP security notice, and select **Start local delivery**. Share the displayed address.
No certificate, domain, QR code, internet connection, or candidate installation is required.

The administrator workspace remains on its existing loopback address. The candidate listener
binds only to the selected private IPv4 interface on TCP 4311. It is not a cloud/public endpoint.
Candidate invitations and assessment access links use this listener's address automatically.
An enabled listener restores after Host restart when its saved address is still assigned.
Stopping delivery persists the disabled state. Changing DHCP addresses requires setup again;
reserve the Host's address on the router to avoid this during examinations.

## Security and infrastructure

HTTP exposes passwords, session cookies and examination traffic to network interception or
tampering. Local Wi-Fi is not a substitute for encryption. Use a controlled network, never
forward the port from the internet, and retain HTTPS for deployments requiring transport security.
Use dummy accounts and unique passwords for validation. An operating-system firewall exception
may still require administrator permission; do not disable the firewall. Allow only the Host
application/TCP 4311 on the trusted Private network and local subnet. Client/guest isolation must
not block access to the Host. VPN/virtual interfaces are not reliably distinguishable from
physical interfaces; the administrator must choose the correct one when several are present.

The screen reports network addresses seen recently, not authenticated candidates or capacity.
It does not infer internet independence from a heartbeat. No external connectivity checks,
DNS, certificate service, CDN, or cloud API is used by this delivery service.

## Physical acceptance test (still required)

1. Start local delivery on the Host, with the built frontend available.
2. Disconnect router WAN, leave LAN/Wi-Fi on; disable mobile data and VPN on test devices.
3. Open the displayed address from a fresh browser on two phones and a laptop. Verify the Host
   receives a connection. Register separate dummy candidates, approve them and assign a roster.
4. Launch a 30-minute mixed assessment. Verify acknowledgement of concurrent answer saves.
5. Disconnect/reconnect one phone; reopen another browser. Confirm acknowledged answers return.
6. Restart the Host with the same database/address. Confirm the listener and answers recover.
   The official deadline continues; interruptions do not automatically pause time.
7. Review/submit, manually mark written answers and export results. Compare expected scores.
8. Stop delivery and confirm devices cannot access it. Restart the Host and verify it stays off.

Record devices, browsers, network equipment, save delays and failures. A few devices prove a
functional path, not 200-candidate capacity. This does not prove cloud package import/sync.

The current Host is a Node application; a signed desktop installer, firewall provisioning and
native power-management integration are separate work. The browser interface now starts and
stops the actual LAN server, but does not install system software or change router settings.
