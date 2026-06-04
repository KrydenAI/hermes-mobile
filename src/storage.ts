import * as SecureStore from 'expo-secure-store';
import type { ConnectionProfile } from './types';

const KEY = 'hermes-mobile.connection-profiles.v1';

export async function loadProfiles(): Promise<ConnectionProfile[]> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as ConnectionProfile[]; } catch { return []; }
}

export async function saveProfiles(profiles: ConnectionProfile[]): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(profiles));
}

export async function upsertProfile(profile: ConnectionProfile): Promise<ConnectionProfile[]> {
  const profiles = await loadProfiles();
  const next = [profile, ...profiles.filter(p => p.id !== profile.id)].slice(0, 8);
  await saveProfiles(next);
  return next;
}

export async function deleteProfile(id: string): Promise<ConnectionProfile[]> {
  const profiles = (await loadProfiles()).filter(p => p.id !== id);
  await saveProfiles(profiles);
  return profiles;
}
