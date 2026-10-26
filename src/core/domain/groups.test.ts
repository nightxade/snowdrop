import { describe, expect, it } from 'vitest';
import { groupConversationId } from './ids';
import type { Conversation } from './types';
import {
  canAddMembers,
  canEditGroupInfo,
  canManageGroup,
  canSendToGroup,
  mustChooseNewAdmin,
} from './groups';

const group = (extra: Partial<Conversation> = {}): Conversation => ({
  id: groupConversationId('g'),
  kind: 'group',
  title: 'G',
  memberIds: ['me', 'al', 'bo'],
  adminIds: ['al'],
  expireTimerSec: 0,
  lastActivityAt: 0,
  ...extra,
});
const open = {
  addMember: 'every-member',
  editDetails: 'every-member',
  sendMessages: 'every-member',
} as const;
const closed = {
  addMember: 'only-admins',
  editDetails: 'only-admins',
  sendMessages: 'only-admins',
} as const;

describe('group permissions', () => {
  it('follows the rules for members and always lets admins', () => {
    expect(canEditGroupInfo(group({ permissions: open }), 'me')).toBe(true);
    expect(canAddMembers(group({ permissions: open }), 'me')).toBe(true);
    expect(canEditGroupInfo(group({ permissions: closed }), 'me')).toBe(false);
    expect(canAddMembers(group({ permissions: closed }), 'me')).toBe(false);
    expect(canEditGroupInfo(group({ permissions: closed }), 'al')).toBe(true);
    expect(canAddMembers(group({ permissions: closed }), 'al')).toBe(true);
  });

  it('assumes admins only when the rules are unknown, and never for a non-member', () => {
    expect(canEditGroupInfo(group(), 'me')).toBe(false);
    expect(canEditGroupInfo(group(), 'al')).toBe(true);
    expect(canAddMembers(group({ permissions: open }), 'stranger')).toBe(false);
    expect(canAddMembers(group({ permissions: open }), null)).toBe(false);
  });

  it('keeps removing, admins, link and rules for admins', () => {
    expect(canManageGroup(group({ permissions: open }), 'me')).toBe(false);
    expect(canManageGroup(group(), 'al')).toBe(true);
  });

  it('stops non-admins sending in an announcement group', () => {
    expect(canSendToGroup(group({ permissions: closed }), 'me')).toBe(false);
    expect(canSendToGroup(group({ permissions: closed }), 'al')).toBe(true);
    expect(canSendToGroup(group({ permissions: open }), 'me')).toBe(true);
    expect(canSendToGroup(group(), 'me')).toBe(true);
  });

  it('makes a group we left read-only with nothing to do in it', () => {
    const gone = group({ permissions: open, left: true, adminIds: ['me'] });
    expect(canEditGroupInfo(gone, 'me')).toBe(false);
    expect(canAddMembers(gone, 'me')).toBe(false);
    expect(canManageGroup(gone, 'me')).toBe(false);
    expect(canSendToGroup(gone, 'me')).toBe(false);
    expect(mustChooseNewAdmin(gone, 'me')).toBe(false);
  });

  it('makes only the sole admin of a group with others choose a successor', () => {
    expect(mustChooseNewAdmin(group({ adminIds: ['me'] }), 'me')).toBe(true);
    expect(mustChooseNewAdmin(group({ adminIds: ['me', 'al'] }), 'me')).toBe(false);
    expect(mustChooseNewAdmin(group({ adminIds: ['al'] }), 'me')).toBe(false);
    expect(mustChooseNewAdmin(group({ adminIds: ['me'], memberIds: ['me'] }), 'me')).toBe(false);
  });
});
