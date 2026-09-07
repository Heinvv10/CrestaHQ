export interface SmtpMeta {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromEmail: string;
  fromName: string;
  verifiedAt: string;
}

export interface SmtpConnection extends SmtpMeta {
  password: string;
}
