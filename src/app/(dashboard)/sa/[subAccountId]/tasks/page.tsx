"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckSquare, Plus } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { useSubAccountContacts } from "@/context/contacts-context";
import { subscribeToTasks } from "@/lib/firestore/tasks";
import { useEffectiveTerritoryFilter } from "@/hooks/use-effective-territory-filter";
import { toDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { RENDER_STEP, ShowMoreRows } from "@/components/show-more-rows";
import { TaskDialog } from "@/components/tasks/task-dialog";
import { TaskItem } from "@/components/tasks/task-item";
import { cn } from "@/lib/utils";
import { SELECT_CLASS } from "@/components/assignee-select";
import { useSubAccountMembers } from "@/hooks/use-sub-account-members";
import type { Contact } from "@/types/contacts";
import type { Task, TaskFilter } from "@/types/tasks";

export default function TasksPage() {
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, agencyId } = useSubAccount();
  const { ready: filterReady, filter: territoryFilter } =
    useEffectiveTerritoryFilter();
  const [tasks, setTasks] = useState<Task[]>([]);
  const { contacts, loading: contactsLoading } = useSubAccountContacts();
  const [tasksLoading, setTasksLoading] = useState(true);
  const loading = tasksLoading || contactsLoading;
  const [filter, setFilter] = useState<TaskFilter>("today");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [renderLimit, setRenderLimit] = useState(RENDER_STEP);

  useEffect(() => {
    if (authLoading || !user || !agencyId) return;
    if (!filterReady) return;
    setTasksLoading(true);
    const scope = { agencyId, subAccountId };
    const unsubT = subscribeToTasks(scope, { territoryFilter }, (l) => {
      setTasks(l);
      setTasksLoading(false);
    });
    return () => {
      unsubT();
    };
  }, [user, agencyId, subAccountId, authLoading, filterReady, territoryFilter]);

  const contactById = useMemo(() => {
    const m = new Map<string, Contact>();
    for (const c of contacts) m.set(c.id, c);
    return m;
  }, [contacts]);

  // Assignee filter: "anyone" | "me" | "unassigned" | a member uid. Applied
  // before bucketing so every tab count reflects it.
  const [assignee, setAssignee] = useState("anyone");
  const { members } = useSubAccountMembers(subAccountId);
  const scoped = useMemo(() => {
    if (assignee === "anyone") return tasks;
    if (assignee === "unassigned") return tasks.filter((t) => !t.assignedToUid);
    const uid = assignee === "me" ? user?.uid : assignee;
    return tasks.filter((t) => t.assignedToUid === uid);
  }, [tasks, assignee, user?.uid]);

  const buckets = useMemo(() => {
    const now = Date.now();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const overdue: Task[] = [];
    const todayList: Task[] = [];
    const upcoming: Task[] = [];
    const done: Task[] = [];

    for (const t of scoped) {
      if (t.completed) {
        done.push(t);
        continue;
      }
      const d = toDate(t.dueAt);
      if (!d) {
        upcoming.push(t);
        continue;
      }
      const day = new Date(d);
      day.setHours(0, 0, 0, 0);
      if (d.getTime() < now && day.getTime() < today.getTime()) {
        overdue.push(t);
      } else if (day.getTime() === today.getTime()) {
        todayList.push(t);
      } else {
        upcoming.push(t);
      }
    }
    return { overdue, today: todayList, upcoming, done };
  }, [scoped]);

  const counts = {
    today: buckets.today.length + buckets.overdue.length,
    overdue: buckets.overdue.length,
    upcoming: buckets.upcoming.length,
    done: buckets.done.length,
    all: scoped.length,
  };

  const shown =
    filter === "today"
      ? [...buckets.overdue, ...buckets.today]
      : filter === "overdue"
        ? buckets.overdue
        : filter === "upcoming"
          ? buckets.upcoming
          : filter === "done"
            ? buckets.done.slice(0, 100)
            : scoped;

  function openNew() {
    setEditTask(null);
    setDialogOpen(true);
  }

  function openEdit(task: Task) {
    setEditTask(task);
    setDialogOpen(true);
  }

  const FILTERS: { id: TaskFilter; label: string; count: number }[] = [
    { id: "today", label: "Today", count: counts.today },
    { id: "overdue", label: "Overdue", count: counts.overdue },
    { id: "upcoming", label: "Upcoming", count: counts.upcoming },
    { id: "done", label: "Done", count: counts.done },
  ];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Tasks</h1>
          <p className="text-sm text-muted-foreground">
            Follow-ups and reminders so nothing slips.
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus className="mr-1 h-4 w-4" />
          New Task
        </Button>
      </div>

      <div className="flex flex-wrap gap-1 rounded-xl border bg-muted/30 p-1">
        {FILTERS.map((f) => {
          const isActive = filter === f.id;
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-all",
                isActive
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
              <span
                className={cn(
                  "rounded-full px-1.5 text-[11px] tabular-nums",
                  isActive ? "bg-muted" : "bg-background/80",
                )}
              >
                {f.count}
              </span>
            </button>
          );
        })}
        <select
          aria-label="Assignee"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          className={cn(SELECT_CLASS, "ml-auto w-auto self-center")}
        >
          <option value="anyone">Anyone</option>
          <option value="me">Me</option>
          <option value="unassigned">Unassigned</option>
          {members.map((m) => (
            <option key={m.uid} value={m.uid}>
              {m.displayName}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <ListSkeleton />
      ) : shown.length === 0 ? (
        <EmptyState filter={filter} onAdd={openNew} />
      ) : (
        <div className="space-y-2">
          {shown.slice(0, renderLimit).map((t) => (
            <TaskItem
              key={t.id}
              task={t}
              contact={t.contactId ? contactById.get(t.contactId) : undefined}
              onClick={openEdit}
            />
          ))}
          <ShowMoreRows
            shown={Math.min(renderLimit, shown.length)}
            total={shown.length}
            onMore={() => setRenderLimit((n) => n + RENDER_STEP)}
          />
        </div>
      )}

      <TaskDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        contacts={contacts}
        task={editTask}
      />
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="h-16 animate-pulse rounded-xl border bg-muted/30"
        />
      ))}
    </div>
  );
}

function EmptyState({
  filter,
  onAdd,
}: {
  filter: TaskFilter;
  onAdd: () => void;
}) {
  const copy: Record<TaskFilter, { title: string; desc: string }> = {
    today: {
      title: "Nothing due today",
      desc: "You're caught up. Add a task to stay ahead.",
    },
    overdue: {
      title: "No overdue tasks",
      desc: "Clean slate — nothing's slipped.",
    },
    upcoming: {
      title: "No upcoming tasks",
      desc: "Plan a follow-up or reminder.",
    },
    done: {
      title: "Nothing completed yet",
      desc: "Completed tasks will land here.",
    },
    all: { title: "No tasks yet", desc: "Add your first follow-up." },
  };
  const { title, desc } = copy[filter];
  return (
    <div className="rounded-xl border border-dashed bg-card/50 p-10 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <CheckSquare className="h-6 w-6 text-primary" />
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
      <div className="mt-6 flex justify-center">
        <Button onClick={onAdd}>
          <Plus className="mr-1 h-4 w-4" />
          New task
        </Button>
      </div>
    </div>
  );
}
