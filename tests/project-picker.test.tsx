// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReviewProject } from '../src/core/projects';
import { ProjectPicker } from '../src/ui/ProjectPicker';

const projects: ReviewProject[] = Array.from({ length: 3 }, (_, index) => ({
  id: 'project-' + index, name: '项目' + index, localPath: '/articles/' + index + '/document.xml',
  defaultDirection: 'pull', createdAt: '2026-09-12T00:00:00Z',
}));
const trigger = () => screen.getByRole('combobox', { name: '当前项目' });
const currentProjectName = () => document.getElementById(trigger().getAttribute('aria-describedby')!)?.textContent;
const option = (index: number) => screen.getByRole('option', { name: projects[index].name });
const highlighted = () => document.getElementById(trigger().getAttribute('aria-activedescendant')!);
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('page-owned project picker', () => {
  it('keeps the switch label visible without native or custom hover and focus tooltips', async () => {
    const user=userEvent.setup(), onSwitch=vi.fn();
    render(<ProjectPicker projects={projects} active={projects[1]} disabled={false} onSwitch={onSwitch}/>);
    expect(currentProjectName()).toBe(projects[1].name);
    expect(within(trigger()).getByText('切换项目')).toBeDefined();
    expect(trigger().hasAttribute('title')).toBe(false);
    expect(trigger().querySelector('.project-picker-icon')).toBeNull();
    await user.hover(trigger());
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.unhover(trigger());act(()=>trigger().focus());
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(within(trigger()).getByText('切换项目')).toBeDefined();
    await user.keyboard('{Enter}');expect(screen.getByRole('listbox')).toBeDefined();
    expect(screen.queryByRole('tooltip')).toBeNull();expect(onSwitch).not.toHaveBeenCalled();
  });

  it('navigates without switching and keeps the accepted title when a switch is rejected', async () => {
    const onSwitch = vi.fn();
    const { rerender } = render(<ProjectPicker projects={projects} active={projects[1]} disabled={false} onSwitch={onSwitch}/>);
    act(() => trigger().focus());
    await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toBe(trigger());
    expect(highlighted()).toBe(option(1));
    expect(option(1).getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{ArrowDown}');
    expect(highlighted()).toBe(option(2));
    expect(option(1).getAttribute('aria-selected')).toBe('true');
    expect(option(2).getAttribute('aria-selected')).toBe('false');
    expect(onSwitch).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    expect(onSwitch.mock.calls).toEqual([[projects[2].id]]);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(currentProjectName()).toBe(projects[1].name);
    await userEvent.keyboard(' ');
    expect(highlighted()).toBe(option(1));
    await userEvent.keyboard('{ArrowUp} ');
    expect(onSwitch.mock.calls).toEqual([[projects[2].id], [projects[0].id]]);
    expect(currentProjectName()).toBe(projects[1].name);
    rerender(<ProjectPicker projects={projects} active={projects[0]} disabled={false} onSwitch={onSwitch}/>);
    expect(currentProjectName()).toBe(projects[0].name);
  });

  it('cancels with Escape and Tab without stealing the next or previous control focus', async () => {
    const onSwitch = vi.fn();
    render(<><button>前一个</button><ProjectPicker projects={projects} active={projects[1]} disabled={false} onSwitch={onSwitch}/><button>后一个</button></>);
    await userEvent.click(trigger());
    await userEvent.keyboard('{ArrowDown}{Escape}');
    expect(document.activeElement).toBe(trigger());
    expect(screen.queryByRole('listbox')).toBeNull();
    await userEvent.keyboard('{ArrowDown}{Tab}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '后一个' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    await userEvent.click(trigger());
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '前一个' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('closes on outside pointer and focus changes without refocusing the trigger', async () => {
    render(<><ProjectPicker projects={projects} active={projects[1]} disabled={false} onSwitch={vi.fn()}/><input aria-label="外部输入"/></>);
    await userEvent.click(trigger());
    await userEvent.click(screen.getByLabelText('外部输入'));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('外部输入'));
    await userEvent.click(trigger());
    act(() => screen.getByLabelText('外部输入').focus());
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('外部输入'));
  });

  it('does not choose a candidate if the surrounding operation becomes busy', async () => {
    const onSwitch = vi.fn();
    const { rerender } = render(<ProjectPicker projects={projects} active={projects[1]} disabled={false} onSwitch={onSwitch}/>);
    await userEvent.click(trigger());
    await userEvent.keyboard('{ArrowDown}');
    rerender(<ProjectPicker projects={projects} active={projects[1]} disabled onSwitch={onSwitch}/>);
    expect(screen.queryByRole('listbox')).toBeNull();
    await userEvent.click(trigger());
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onSwitch).not.toHaveBeenCalled();
    expect(currentProjectName()).toBe(projects[1].name);
  });

  it('opens Home and End at the corresponding endpoint and scrolls the active long-list item into view', async () => {
    const longProjects = Array.from({ length: 80 }, (_, index) => ({ ...projects[0], id: 'long-' + index,
      name: '长项目名称需要完整辨认并可滚动选择-' + index, localPath: '/articles/project-' + index + '/document.xml' }));
    const scrolled: Element[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: function(this: Element) { scrolled.push(this); } });
    try {
      render(<ProjectPicker projects={longProjects} active={longProjects[70]} disabled={false} onSwitch={vi.fn()}/>);
      await userEvent.click(trigger());
      expect(highlighted()?.textContent).toContain(longProjects[70].name);
      expect(scrolled.at(-1)).toBe(highlighted());
      expect(within(highlighted()!).getByText(longProjects[70].localPath).getAttribute('title')).toBe(longProjects[70].localPath);
      await userEvent.keyboard('{Escape}{Home}');
      expect(highlighted()?.textContent).toContain(longProjects[0].name);
      await userEvent.keyboard('{Escape}{End}');
      expect(highlighted()?.textContent).toContain(longProjects[79].name);
      await userEvent.keyboard('{Home}{ArrowDown}');
      expect(highlighted()?.textContent).toContain(longProjects[1].name);
      expect(currentProjectName()).toBe(longProjects[70].name);
    } finally {
      if (descriptor) Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor);
      else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it.each([[375, 320], [1280, 375]])('anchors below the trigger with bounded dimensions at %ix%i', async (width, height) => {
    vi.stubGlobal('innerWidth', width); vi.stubGlobal('innerHeight', height);
    render(<ProjectPicker projects={projects} active={projects[1]} disabled={false} onSwitch={vi.fn()}/>);
    vi.spyOn(trigger(), 'getBoundingClientRect').mockReturnValue(new DOMRect(width - 140, 20, 130, 32));
    await userEvent.click(trigger());
    const popup = screen.getByRole('listbox');
    expect(popup.parentElement).toBe(document.body);
    expect(Number.parseFloat(popup.style.top)).toBe(57);
    expect(Number.parseFloat(popup.style.left)).toBeGreaterThanOrEqual(12);
    expect(Number.parseFloat(popup.style.left) + Number.parseFloat(popup.style.width)).toBeLessThanOrEqual(width - 12);
    expect(Number.parseFloat(popup.style.top) + Number.parseFloat(popup.style.maxHeight)).toBeLessThanOrEqual(height - 12);
    fireEvent.resize(window);
    expect(screen.getByRole('listbox')).toBe(popup);
  });

  it('uses project identity rather than a duplicate display name', async () => {
    const sameNames = projects.map(project => ({ ...project, name: '同名项目' }));
    const onSwitch = vi.fn();
    render(<ProjectPicker projects={sameNames} active={sameNames[0]} disabled={false} onSwitch={onSwitch}/>);
    await userEvent.click(trigger());
    const chosen = screen.getByText(sameNames[2].localPath).closest('button')!;
    await userEvent.click(chosen);
    expect(onSwitch.mock.calls).toEqual([[sameNames[2].id]]);
    expect(currentProjectName()).toBe(sameNames[0].name);
  });
});
