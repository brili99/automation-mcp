import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';

export type ValidatedSchedule = {
  cronExpression: string;
  timezone: string;
};

export function validateSchedule(cronExpression: string, timezone: string): ValidatedSchedule {
  const expression = z.string().min(1).max(200).parse(cronExpression);
  const ianaTimezone = z.string().min(1).max(100).parse(timezone);

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: ianaTimezone });
    CronExpressionParser.parse(expression, { tz: ianaTimezone, currentDate: new Date() });
  } catch (error) {
    throw new Error(`Invalid cron expression or IANA time zone: ${errorMessage(error)}`);
  }

  return { cronExpression: expression, timezone: ianaTimezone };
}

export function nextOccurrence(schedule: ValidatedSchedule, after: Date): Date {
  const expression = CronExpressionParser.parse(schedule.cronExpression, {
    tz: schedule.timezone,
    currentDate: after,
  });
  return expression.next().toDate();
}

export function occurrencesBetween(
  schedule: ValidatedSchedule,
  after: Date,
  through: Date,
  limit = 1000,
): Date[] {
  const occurrences: Date[] = [];
  const expression = CronExpressionParser.parse(schedule.cronExpression, {
    tz: schedule.timezone,
    currentDate: after,
  });
  while (expression.hasNext()) {
    const occurrence = expression.next().toDate();
    if (occurrence.getTime() > through.getTime()) {
      break;
    }
    if (occurrences.length >= limit) {
      throw new Error(`Schedule generated more than ${limit} due occurrences in one poll.`);
    }
    occurrences.push(occurrence);
  }
  return occurrences;
}

export function validateTimezone(timezone: string): string {
  const value = z.string().min(1).max(100).parse(timezone);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw new Error(`Invalid IANA time zone: ${value}`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
