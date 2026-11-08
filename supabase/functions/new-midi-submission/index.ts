import { withSupabase } from "npm:@supabase/server@^1";

type SubmissionRecord = {
  title?: string;
  part?: string;
  composer?: string | null;
  status?: string;
  "storage path"?: string;
};

type WebhookPayload = {
  type?: string;
  table?: string;
  schema?: string;
  record?: SubmissionRecord;
};

const htmlEntities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  "\"": "&quot;"
};

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => htmlEntities[character] ?? character);

const handler = async (request: Request): Promise<Response> => {
  const payload = await request.json() as WebhookPayload;
  if (payload.type !== "INSERT" || payload.schema !== "public" || payload.table !== "midi_files") {
    return Response.json({ ignored: true });
  }

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const recipient = Deno.env.get("NOTIFICATION_TO_EMAIL");
  const sender = Deno.env.get("NOTIFICATION_FROM_EMAIL");
  if (!resendApiKey || !recipient || !sender) {
    return Response.json({ error: "Notification secrets are not configured." }, { status: 500 });
  }

  const record = payload.record ?? {};
  const title = escapeHtml(record.title || "Untitled MIDI submission");
  const part = escapeHtml(record.part || "No part provided");
  const composer = escapeHtml(record.composer || "Not provided");
  const storagePath = escapeHtml(record["storage path"] || "Not provided");

  const emailResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resendApiKey}`
    },
    body: JSON.stringify({
      from: sender,
      to: [recipient],
      subject: `New MIDI submission: ${record.title || "Untitled"}`,
      html: `
        <h1>New MIDI submission</h1>
        <p>A file is ready for review in OnSight Music.</p>
        <ul>
          <li><strong>Title:</strong> ${title}</li>
          <li><strong>Part:</strong> ${part}</li>
          <li><strong>Composer / arranger:</strong> ${composer}</li>
          <li><strong>Storage path:</strong> <code>${storagePath}</code></li>
        </ul>
      `
    })
  });

  if (!emailResponse.ok) {
    console.error("Resend rejected the notification", await emailResponse.text());
    return Response.json({ error: "Email notification failed." }, { status: 502 });
  }

  return Response.json({ notified: true });
};

// Database Webhooks call this function with the project's secret key.
export default { fetch: withSupabase({ auth: ["secret"] }, handler) };
