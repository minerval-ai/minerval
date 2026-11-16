#!/usr/bin/env python3
"""Confine this process to a set of paths, then become the command.

The sandbox service (server.py) starts every command through this file:

    confine.py --spec '<json>' -- /bin/bash -c '<the command>'

The service holds every file set the deployment has, and one run may read
only some of them: a run works at a label, and a set whose label that label
does not read is not the run's to open. A command is an agent's own shell
line, so nothing the service checks about the command's text could hold it
to its sets. The kernel does. This file uses Landlock (Linux 5.13 and
later), which lets an unprivileged process give up, for itself and for
everything it starts, all access to the filesystem except the paths it
names. The restriction cannot be lifted afterwards.

What the command is left with:

  - read and execute under the system paths (the interpreter, the
    libraries, the shell tools);
  - read and execute under each set the run was given, and nothing else of
    the store they live in: not another set's files, and not the listing
    of the directory the sets are kept in;
  - everything under its own scratch directory;
  - /dev/null, /dev/zero and the random devices.

It has no /proc, so it cannot read another process's environment or
working directory, and no path to any other run's scratch directory. It has
no /dev/shm either: that directory is one for the whole machine, so
granting it would let a command of one run leave something for a command
of another, whatever labels the two work at. The cost is that POSIX
semaphores cannot be made, so a Python multiprocessing pool does not start.
Threads and subprocesses do.

Where the kernel offers more, more is taken: TCP connections are refused
(Landlock ABI 4, Linux 6.7) and signals to processes outside the command
are refused (ABI 6, Linux 6.12). These are additions. That the sandbox has
no network is the container's property, checked by the service's probe:
Landlock does not cover every protocol.

If Landlock is not available the command is not run. `--check` prints the
ABI version the kernel offers, or 0.

Only the standard library is used, and nothing here is imported by the
service: each command gets a fresh, single-threaded process.
"""
import ctypes
import json
import os
import resource
import sys

SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
PR_SET_NO_NEW_PRIVS = 38

FS_EXECUTE = 1 << 0
FS_WRITE_FILE = 1 << 1
FS_READ_FILE = 1 << 2
FS_READ_DIR = 1 << 3
FS_REMOVE_DIR = 1 << 4
FS_REMOVE_FILE = 1 << 5
FS_MAKE_CHAR = 1 << 6
FS_MAKE_DIR = 1 << 7
FS_MAKE_REG = 1 << 8
FS_MAKE_SOCK = 1 << 9
FS_MAKE_FIFO = 1 << 10
FS_MAKE_BLOCK = 1 << 11
FS_MAKE_SYM = 1 << 12
FS_REFER = 1 << 13  # ABI 2
FS_TRUNCATE = 1 << 14  # ABI 3
FS_IOCTL_DEV = 1 << 15  # ABI 5

NET_BIND_TCP = 1 << 0  # ABI 4
NET_CONNECT_TCP = 1 << 1  # ABI 4
SCOPE_ABSTRACT_UNIX_SOCKET = 1 << 0  # ABI 6
SCOPE_SIGNAL = 1 << 1  # ABI 6

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


class RulesetAttr(ctypes.Structure):
    _fields_ = [
        ("handled_access_fs", ctypes.c_uint64),
        ("handled_access_net", ctypes.c_uint64),
        ("scoped", ctypes.c_uint64),
    ]


class PathBeneathAttr(ctypes.Structure):
    # The kernel's struct is packed: twelve bytes, with no padding after the
    # descriptor. _layout_ says which packing rule _pack_ means; Python 3.14
    # warns where it is left out, and earlier versions do not read it.
    _pack_ = 1
    _layout_ = "ms"
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


def landlock_abi():
    """The Landlock ABI version this kernel offers, or 0 when it has none."""
    version = libc.syscall(
        SYS_LANDLOCK_CREATE_RULESET, None, ctypes.c_size_t(0), ctypes.c_uint32(LANDLOCK_CREATE_RULESET_VERSION)
    )
    return int(version) if version > 0 else 0


def all_fs_rights(abi):
    rights = (
        FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_READ_DIR | FS_REMOVE_DIR | FS_REMOVE_FILE
        | FS_MAKE_CHAR | FS_MAKE_DIR | FS_MAKE_REG | FS_MAKE_SOCK | FS_MAKE_FIFO | FS_MAKE_BLOCK | FS_MAKE_SYM
    )
    if abi >= 2:
        rights |= FS_REFER
    if abi >= 3:
        rights |= FS_TRUNCATE
    if abi >= 5:
        rights |= FS_IOCTL_DEV
    return rights


def fail(message):
    sys.stderr.write("sandbox: " + message + "\n")
    sys.exit(126)


def add_rule(ruleset_fd, path, access, handled):
    """Allow `access` beneath `path`. A path that does not exist grants nothing."""
    try:
        fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
    except OSError:
        return
    try:
        allowed = access & handled
        if not os.path.isdir(path):
            # A rule on a file may name only the rights a file can have.
            allowed &= FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV
        rule = PathBeneathAttr(allowed, fd)
        if libc.syscall(SYS_LANDLOCK_ADD_RULE, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, ctypes.byref(rule), 0) != 0:
            fail("could not allow %s: %s" % (path, os.strerror(ctypes.get_errno())))
    finally:
        os.close(fd)


def confine(spec):
    abi = landlock_abi()
    if abi < 1:
        fail(
            "this kernel has no Landlock, so a command cannot be held to its own file sets and was not run. "
            "The sandbox needs Linux 5.13 or later with Landlock enabled."
        )
    handled = all_fs_rights(abi)
    attr = RulesetAttr(handled, 0, 0)
    size = 8
    if abi >= 4:
        # No rule is added for the network, so every TCP bind and connect is refused.
        attr.handled_access_net = NET_BIND_TCP | NET_CONNECT_TCP
        size = 16
    if abi >= 6:
        attr.scoped = SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL
        size = 24
    ruleset_fd = libc.syscall(SYS_LANDLOCK_CREATE_RULESET, ctypes.byref(attr), ctypes.c_size_t(size), 0)
    if ruleset_fd < 0:
        fail("could not create the Landlock ruleset: %s" % os.strerror(ctypes.get_errno()))

    read = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR
    for path in spec.get("read", []):
        add_rule(ruleset_fd, path, read, handled)
    for path in spec.get("write", []):
        add_rule(ruleset_fd, path, handled, handled)
    for path in ("/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom"):
        add_rule(ruleset_fd, path, FS_READ_FILE | FS_WRITE_FILE, handled)

    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        fail("could not set no_new_privs: %s" % os.strerror(ctypes.get_errno()))
    if libc.syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd, 0) != 0:
        fail("could not apply the Landlock ruleset: %s" % os.strerror(ctypes.get_errno()))
    os.close(ruleset_fd)


def main(argv):
    if argv[1:2] == ["--check"]:
        print(landlock_abi())
        return
    if len(argv) < 5 or argv[1] != "--spec" or argv[3] != "--":
        fail("usage: confine.py --spec '<json>' -- command [argument ...]")
    spec = json.loads(argv[2])
    command = argv[4:]

    # One file may not pass the size the run's whole scratch directory may be.
    fsize = spec.get("file_bytes")
    if fsize:
        resource.setrlimit(resource.RLIMIT_FSIZE, (fsize, fsize))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # If the machine itself runs out of memory, the kernel should end the
    # command and not the service that is running it.
    try:
        with open("/proc/self/oom_score_adj", "w") as f:
            f.write("1000")
    except OSError:
        pass

    confine(spec)
    # What this helper says for itself (a refusal above, or a warning from
    # the interpreter that runs it) goes to the error stream it was started
    # with, which the service keeps apart from the command's output: a kept
    # output is a source, and nothing in it should be this program's words.
    # The command's own error stream joins its output from here on, as a
    # person running it in a terminal would see it.
    own_stderr = os.dup(2)
    os.set_inheritable(own_stderr, False)
    os.dup2(1, 2)
    try:
        os.execvp(command[0], command)
    except OSError as err:
        os.dup2(own_stderr, 2)
        fail("could not start %s: %s" % (command[0], err.strerror))


if __name__ == "__main__":
    main(sys.argv)
