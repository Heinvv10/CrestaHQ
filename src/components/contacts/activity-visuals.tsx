"use client";

import {
  Pencil,
  ListTodo,
  GitBranch,
  CalendarCheck,
  CheckSquare,
  FileText,
  FileSignature,
  Mail,
  MessageSquare,
  MessagesSquare,
  PhoneMissed,
  PhoneOutgoing,
  Zap,
  Send,
  CircleSlash,
  CheckCircle2,
  XCircle,
  Eye,
  DollarSign,
  AlertTriangle,
  MapPinned,
  CalendarPlus,
  CalendarX,
  CalendarClock,
  UserX,
  Users,
  Star,
  MonitorPlay,
  MousePointerClick,
  Moon,
} from "lucide-react";
import type { ActivityType } from "@/types/contacts";

/** Icon + label for each activity row. Kept beside the timeline so the
 *  timeline itself stays under the file-size limit. */
export function activityVisuals(type: ActivityType): {
  icon: React.ReactNode;
  label: string;
} {
  switch (type) {
    case "pipeline_moved":
      return {
        icon: <GitBranch className="h-3 w-3 text-indigo-500" />,
        label: "Pipeline updated",
      };
    case "booking_created":
      return {
        icon: <CalendarCheck className="h-3 w-3 text-emerald-500" />,
        label: "Event scheduled",
      };
    case "task_completed":
      return {
        icon: <CheckSquare className="h-3 w-3 text-emerald-500" />,
        label: "Task completed",
      };
    case "form_submitted":
      return {
        icon: <FileText className="h-3 w-3 text-violet-500" />,
        label: "Form submitted",
      };
    case "email_sent":
      return {
        icon: <Mail className="h-3 w-3 text-blue-500" />,
        label: "Email sent",
      };
    case "email_suppressed":
      return {
        icon: <Mail className="h-3 w-3 text-rose-500" />,
        label: "Email not sent (suppressed)",
      };
    case "sms_sent":
      return {
        icon: <MessageSquare className="h-3 w-3 text-violet-500" />,
        label: "SMS sent",
      };
    case "whatsapp_sent":
      return {
        icon: <MessagesSquare className="h-3 w-3 text-green-500" />,
        label: "WhatsApp sent",
      };
    case "messenger_sent":
      return {
        icon: <MessagesSquare className="h-3 w-3 text-blue-500" />,
        label: "Messenger sent",
      };
    case "instagram_sent":
      return {
        icon: <MessagesSquare className="h-3 w-3 text-pink-500" />,
        label: "Instagram sent",
      };
    case "voice_call_initiated":
      return {
        icon: <PhoneOutgoing className="h-3 w-3 text-orange-500" />,
        label: "AI call placed",
      };
    case "voice_call_completed":
      return {
        icon: <PhoneOutgoing className="h-3 w-3 text-emerald-500" />,
        label: "AI call",
      };
    case "missed_call":
      return {
        icon: <PhoneMissed className="h-3 w-3 text-rose-500" />,
        label: "Missed call",
      };
    case "quiet_hours_held":
      return {
        icon: <Moon className="h-3 w-3 text-indigo-500" />,
        label: "Held for quiet hours",
      };
    case "automation_started":
      return {
        icon: <Zap className="h-3 w-3 text-amber-500" />,
        label: "Automation started",
      };
    case "automation_step_sent":
      return {
        icon: <Send className="h-3 w-3 text-violet-500" />,
        label: "Automation step sent",
      };
    case "automation_step_skipped":
      return {
        icon: <CircleSlash className="text-muted-foreground h-3 w-3" />,
        label: "Automation step skipped",
      };
    case "automation_completed":
      return {
        icon: <CheckCircle2 className="h-3 w-3 text-emerald-500" />,
        label: "Automation completed",
      };
    case "automation_failed":
      return {
        icon: <AlertTriangle className="h-3 w-3 text-rose-500" />,
        label: "Automation failed",
      };
    case "quote_sent":
      return {
        icon: <FileSignature className="h-3 w-3 text-blue-500" />,
        label: "Quote sent",
      };
    case "quote_viewed":
      return {
        icon: <Eye className="h-3 w-3 text-indigo-500" />,
        label: "Quote viewed",
      };
    case "quote_accepted":
      return {
        icon: <CheckCircle2 className="h-3 w-3 text-emerald-500" />,
        label: "Quote accepted",
      };
    case "quote_declined":
      return {
        icon: <XCircle className="h-3 w-3 text-rose-500" />,
        label: "Quote declined",
      };
    case "quote_marked_paid":
      return {
        icon: <DollarSign className="h-3 w-3 text-emerald-500" />,
        label: "Quote paid",
      };
    case "review_requested":
      return {
        icon: <Star className="h-3 w-3 text-amber-500" />,
        label: "Review requested",
      };
    case "contact_territory_changed":
      return {
        icon: <MapPinned className="h-3 w-3 text-sky-500" />,
        label: "Territory changed",
      };
    case "booking_page_booked":
      return {
        icon: <CalendarPlus className="h-3 w-3 text-teal-500" />,
        label: "Meeting booked",
      };
    case "booking_payment_received":
      return {
        icon: <DollarSign className="h-3 w-3 text-emerald-500" />,
        label: "Booking payment received",
      };
    case "booking_cancelled":
      return {
        icon: <CalendarX className="h-3 w-3 text-rose-500" />,
        label: "Meeting cancelled",
      };
    case "booking_rescheduled":
      return {
        icon: <CalendarClock className="h-3 w-3 text-amber-500" />,
        label: "Meeting rescheduled",
      };
    case "booking_no_show":
      return {
        icon: <UserX className="h-3 w-3 text-rose-500" />,
        label: "No-show",
      };
    case "booking_completed":
      return {
        icon: <CheckCircle2 className="h-3 w-3 text-emerald-500" />,
        label: "Meeting completed",
      };
    case "booking_reassigned":
      return {
        icon: <Users className="h-3 w-3 text-indigo-500" />,
        label: "Booking reassigned",
      };
    case "webinar_registered":
      return {
        icon: <MonitorPlay className="h-3 w-3 text-violet-500" />,
        label: "Webinar registration",
      };
    case "webinar_joined":
      return {
        icon: <MonitorPlay className="h-3 w-3 text-sky-500" />,
        label: "Joined webinar",
      };
    case "webinar_completed":
      return {
        icon: <CheckCircle2 className="h-3 w-3 text-emerald-500" />,
        label: "Webinar completed",
      };
    case "webinar_cta_clicked":
      return {
        icon: <MousePointerClick className="h-3 w-3 text-amber-500" />,
        label: "Webinar offer clicked",
      };
    case "sms_received":
      return {
        icon: <MessageSquare className="h-3 w-3 text-violet-500" />,
        label: "SMS received",
      };
    case "whatsapp_received":
      return {
        icon: <MessagesSquare className="h-3 w-3 text-green-500" />,
        label: "WhatsApp received",
      };
    case "email_received":
      return {
        icon: <Mail className="h-3 w-3 text-blue-500" />,
        label: "Email received",
      };
    case "messenger_received":
      return {
        icon: <MessagesSquare className="h-3 w-3 text-blue-500" />,
        label: "Messenger received",
      };
    case "instagram_received":
      return {
        icon: <MessagesSquare className="h-3 w-3 text-pink-500" />,
        label: "Instagram received",
      };
    case "webchat_received":
      return {
        icon: <MessageSquare className="h-3 w-3 text-teal-500" />,
        label: "Web chat received",
      };
    case "task_created":
      return {
        icon: <ListTodo className="h-3 w-3 text-sky-500" />,
        label: "Task created",
      };
    case "note_added":
    default:
      return {
        icon: <Pencil className="text-muted-foreground h-3 w-3" />,
        label: "Note added",
      };
  }
}
