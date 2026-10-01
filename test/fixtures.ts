// Webhook payloads in the shapes Meta documents for Cloud API and Coexistence.
export const BUSINESS = "5511940000000";
const metadata = { display_phone_number: "55 11 94000-0000", phone_number_id: "123456" };

export const inboundText = {
  object: "whatsapp_business_account",
  entry: [{
    id: "WABA",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata,
        contacts: [{ wa_id: "5511990001111", profile: { name: "Marina Teste" } }],
        messages: [{
          from: "5511990001111",
          id: "wamid.IN1",
          timestamp: "1759140000",
          type: "text",
          text: { body: "Interessante. Pode enviar sim." },
          context: { from: BUSINESS, id: "wamid.OUT1" },
        }],
      },
    }],
  }],
};

export const inboundImage = {
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata,
    contacts: [{ wa_id: "971560003333", profile: { name: "Sara" } }],
    messages: [{ from: "971560003333", id: "wamid.IMG1", timestamp: "1759150000", type: "image",
      image: { id: "MEDIA1", mime_type: "image/jpeg", caption: "our showreel" } }],
  } }] }],
};

export const echo = {
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "smb_message_echoes", value: {
    messaging_product: "whatsapp", metadata,
    message_echoes: [{ from: BUSINESS, to: "5511990001111", id: "wamid.OUT1", timestamp: "1759050000",
      type: "text", text: { body: "Olá Marina! Sou o Mohammed da Inhouse." } }],
  } }] }],
};

export const statuses = (status: string, id = "wamid.OUT1") => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata,
    statuses: [{ id, status, timestamp: "1759060000", recipient_id: "5511990001111",
      ...(status === "failed" ? { errors: [{ code: 131026, title: "Message undeliverable" }] } : {}) }],
  } }] }],
});

export const history = {
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "history", value: {
    messaging_product: "whatsapp", metadata,
    history: [{
      metadata: { phase: 0, chunk_order: 1, progress: 100 },
      threads: [{ id: "554133334444", messages: [
        { from: BUSINESS, to: "554133334444", id: "wamid.H1", timestamp: "1750000000", type: "text",
          text: { body: "Hi from the past" }, history_context: { status: "READ" } },
        { from: "554133334444", id: "wamid.H2", timestamp: "1750000100", type: "text", text: { body: "Old reply" } },
      ] }],
    }],
  } }] }],
};

export const contactSync = {
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "smb_app_state_sync", value: {
    messaging_product: "whatsapp", metadata,
    state_sync: [{ type: "contact", action: "add",
      contact: { full_name: "Estúdio Barro Azul", first_name: "Marina", phone_number: "+55 11 99000-1111" },
      metadata: { timestamp: "1759000000" } }],
  } }] }],
};
