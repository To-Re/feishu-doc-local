import { expect, it } from 'vitest';
import { projectDestination } from '../src/ui/project-path';

it('turns the user-reported home directory input into an explicit new XML destination', () => {
  expect(projectDestination({path:'~/',name:'测试',kind:'new',homeDirectory:'/Users/test'})).toEqual({path:'/Users/test/测试.xml',error:''});
  expect(projectDestination({path:'~/articles/',name:'草稿.xml',kind:'new',homeDirectory:'/Users/test'})).toEqual({path:'/Users/test/articles/草稿.xml',error:''});
});
it('offers a real default destination and keeps file paths independent from project names', () => {
  expect(projectDestination({path:'',name:'完整草稿',kind:'new',defaultDirectory:'/articles'})).toEqual({path:'/articles/完整草稿.xml',error:''});
  expect(projectDestination({path:'/custom/a.xml',name:'任意项目名',kind:'new'})).toEqual({path:'/custom/a.xml',error:''});
  expect(projectDestination({path:'/articles/',name:'a/b',kind:'new'})).toEqual({path:'/articles/a-b.xml',error:''});
});
it('explains incomplete or unsupported inputs instead of silently disabling creation', () => {
  for(const path of ['relative.xml','~other/file.xml','/articles/a.txt','/articles/'])expect(projectDestination({path,name:'测试',kind:'existing'}).error).not.toBe('');
  expect(projectDestination({path:'~/',name:'测试',kind:'new'}).error).toContain('主目录');
  expect(projectDestination({path:'/articles/',name:'',kind:'new'}).error).toContain('项目名称');
});
