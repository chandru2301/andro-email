"use client";

import {
  Archive,
  Briefcase,
  GitBranch,
  Heart,
  Rocket,
  UserPlus,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";

/**
 * Persona icon registry.
 *
 * Kept as an explicit map rather than a dynamic lookup so a typo in persona
 * config fails at build time instead of rendering a blank space.
 */
const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  Archive,
  Briefcase,
  GitBranch,
  Heart,
  Rocket,
  UserPlus,
  Users,
  Wallet,
};

export function PersonaIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const Icon = ICONS[name] ?? Archive;
  return <Icon className={className} />;
}

export type { LucideIcon };
