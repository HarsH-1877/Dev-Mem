export interface OpenCodeHookInput {
  hook_event_name: "chat.message" | "tool.execute.after" | "session.idle";
  session_id: string;
  cwd?: string;

  // For chat.message
  message?: any;

  // For tool.execute.after
  tool?: string;
  callID?: string;
  args?: any;
  output?: string;
  metadata?: any;
}
