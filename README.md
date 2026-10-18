# WhatsApp to Discord Bot

A Node.js bot that forwards messages from a selected WhatsApp group to a Discord channel using a Discord webhook.

## Features

- Forward text messages from a selected WhatsApp group.
- Forward images, videos, and documents with captions.
- Display the sender's name on Discord.
- Use the sender's WhatsApp profile picture as the Discord webhook avatar when available.
- Split long text messages to fit Discord's message length limit.
- Retry requests when Discord applies rate limits.
- Configure sensitive information using environment variables.

## Requirements

- [Node.js](https://nodejs.org/) installed.
- A WhatsApp account.
- A Discord server and a channel where you can create a webhook.

## Installation

1. Clone this repository:

   ```bash
   git clone https://github.com/tafer0o/wp_dc_bot.git
   ```

2. Open the project folder:

   ```bash
   cd wp_dc_bot
   ```

3. Install the dependencies:

   ```bash
   npm install
   ```

4. Create a `.env` file in the project root.

## Configuration

Add the following variables to your `.env` file:

```dotenv
DISCORD_WEBHOOK_URL=YOUR_DISCORD_WEBHOOK_URL
WHATSAPP_GROUP_ID=YOUR_WHATSAPP_GROUP_ID@g.us
```

Replace the example values with your actual Discord webhook URL and WhatsApp group ID.

**Never commit your `.env` file or share your Discord webhook URL publicly.**

### Finding your WhatsApp group ID

Run the bot and check the terminal output. The bot lists the WhatsApp groups associated with your account and their IDs.

Copy the ID of the group you want to forward messages from into `WHATSAPP_GROUP_ID` in your `.env` file.

## Usage

Start the bot with:

```bash
node index.js
```

On the first run, scan the QR code displayed in the terminal using WhatsApp's linked-devices feature.

Once connected, the bot listens for messages from the configured group and forwards eligible messages to Discord.

## Security

The `.gitignore` file excludes sensitive files and local dependencies, including:

- `.env`
- `node_modules/`
- `.wwebjs_auth/`
- `.wwebjs_cache/`

Do not upload your WhatsApp authentication session or environment variables to a public repository.

## Limitations

- The bot forwards messages from one configured WhatsApp group.
- Messages sent by the account running the bot are ignored.
- Only messages supported by the current implementation are forwarded.
- WhatsApp and Discord availability, permissions, and rate limits can affect operation.

## Disclaimer

This project is intended for personal and educational use. Use it responsibly and follow WhatsApp's and Discord's applicable terms and policies.
