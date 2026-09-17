#!/usr/bin/env python3
"""Read-only root ownership boundary for publication and runtime preflight."""
import os
from pathlib import Path
import stat
import sys


def protected(path):
    info = path.lstat()

    if any(name in os.listxattr(path, follow_symlinks=False) for name in
           ('system.posix_acl_access', 'system.posix_acl_default')):
        raise SystemExit(f'runtime path carries an ACL: {path}')
    if info.st_uid != 0 or info.st_mode & 0o022 or (stat.S_ISREG(info.st_mode) and info.st_mode & 0o6000) or path.is_symlink():
        raise SystemExit(f'runtime path is not root-protected: {path}')
    if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
        raise SystemExit(f'unsupported runtime inode: {path}')
    if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
        raise SystemExit(f'hardlinked runtime inode: {path}')


def ancestors(path):
    if not path.is_absolute() or str(path.resolve(strict=True)) != str(path):
        raise SystemExit(f'runtime path must be canonical: {path}')
    for item in reversed((path, *path.parents)):
        protected(item)


mode, value = sys.argv[1:]
root = Path(value)
ancestors(root)
if mode == '--parent':
    raise SystemExit(0)
if mode != '--release':
    raise SystemExit('expected --parent or --release')
environment = root.parent.parent
def walk_error(error):
    raise error


for directory, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
    for name in dirs + files:
        path = Path(directory, name)
        if path.is_symlink():
            relative = str(path.relative_to(root))
            approved = {'WebAdmin/update': 'webadmin-update', 'server/update': 'server-update'}
            if relative not in approved or path.lstat().st_uid != 0:
                raise SystemExit(f'unapproved runtime symlink: {path}')
            target = environment / 'shared' / approved[relative]
            ancestors(target.parent)
            if os.readlink(path) != str(target) or target.is_symlink() or not target.is_dir():
                raise SystemExit(f'invalid shared update target: {path}')
        else:
            protected(path)
