# Check Google Voice alerts with Gmail

The plugin can check Gmail every minute and deliver matching vehicle events directly to its presence sensor. This mode uses the existing Homebridge host and an outbound Google API connection. An idle minute uses one Gmail list request (5 quota units), or 7,200 units per day. Opening a new candidate email costs 60 units. Google's published daily free allowance for new projects is 80 million units. Use a dedicated personal Cloud project and leave billing disabled for a free-only installation. [Gmail API limits](https://developers.google.com/workspace/gmail/api/reference/quota)

1. Enable Gmail API in your personal [Google Cloud project](https://console.cloud.google.com/apis/library/gmail.googleapis.com). Configure the OAuth consent screen for your Google account. Create a **Desktop app** OAuth client and download its JSON file. If you use External/Testing, add your Gmail address as a test user and expect refresh authorization to expire after seven days. [Google OAuth guidance](https://developers.google.com/identity/protocols/oauth2/native-app)
2. On a computer where you can open the Google sign-in page, install this plugin version. Set the downloaded file to mode 0600. Create a private directory with mode 0700. Run the command below with absolute paths and open the printed link on that same computer. The temporary callback listens on loopback. Select the mailbox receiving Google Voice texts and grant Gmail read-only access.
3. Transfer the generated session file privately to Homebridge. Keep the session and state paths outside the plugin installation, in a directory owned by Homebridge with mode 0700. The session file must be mode 0600.
4. In your existing platform configuration set vehicleName to the vehicle name shown in the notification. Add the presence settings below, retaining your existing place ID. Restart the plugin.

```sh
cadillac-onstar-gmail /absolute/private/desktop-client.json /absolute/private/gmail-session.json
```

```json
{
  "vehicleName": "Escalade",
  "presence": {
    "enabled": true,
    "source": "gmail",
    "locations": [{"id": "home", "name": "Home"}],
    "exposeSwitch": true,
    "gmail": {
      "locationName": "homebridge",
      "sessionFile": "/absolute/private/gmail-session.json",
      "stateFile": "/absolute/private/gmail-presence.json"
    }
  }
}
```

Each check searches the previous hour of forwarded Google Voice emails. The plugin reads new candidates, verifies the Google sender and US Vehicle Locate short code, and matches a complete message such as “Escalade arrived at homebridge” or “Escalade departed from homebridge.” These phrases come from app notifications. Actual forwarded Cadillac SMS wording still needs live validation. Unknown formats are ignored. Authorization grants read-only access to the mailbox. Processing uses the message's Gmail delivery time and a stable Gmail message ID.

Duplicate deliveries and overlapping polls preserve the last confirmed state. The first event establishes a silent baseline. Interruptions longer than the one-hour search window can leave state stale until the next crossing. Google request failures trigger exponential backoff and respect Retry-After. [Presence behavior](event-presence.md)
