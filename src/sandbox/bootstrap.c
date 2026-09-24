/* Native-only fork path for the experimental foreground sandbox.
 *
 * Bun is multithreaded. Children created here only call supplied libc function
 * pointers and exec or exit; they never return to the JavaScript VM.
 */
typedef long ssize;
typedef unsigned long usize;

struct pollfd_local { int fd; short events; short revents; };
struct timespec_local { long sec; long nsec; };
struct event_local { int kind; int value; };

static long elapsed_ms(struct timespec_local *start, struct timespec_local *now) {
  return (now->sec - start->sec) * 1000L + (now->nsec - start->nsec) / 1000000L;
}

/* out: guardian pid, init pid, stdout read, stderr read, setup read,
 * supervisor-liveness write, event read. */
int sandbox_bootstrap(void **f, int namespace_flags, char *executable,
                      char **argv, char **env, int cgroup_procs,
                      int cgroup_kill, long hard_deadline_ms, int *out) {
  int (*pipe2_fn)(int *, int) = f[0];
  int (*fork_fn)(void) = f[1];
  int (*close_fn)(int) = f[2];
  int (*dup2_fn)(int,int) = f[3];
  int (*open_fn)(char *,int,int) = f[4];
  int (*unshare_fn)(int) = f[5];
  int (*exec_fn)(char *,char **,char **) = f[6];
  ssize (*write_fn)(int,void *,usize) = f[7];
  ssize (*read_fn)(int,void *,usize) = f[8];
  int (*wait_fn)(int,int *,int) = f[9];
  int (*poll_fn)(struct pollfd_local *,usize,int) = f[10];
  int (*clock_fn)(int,struct timespec_local *) = f[11];
  void (*exit_fn)(int) = f[12];
  int *(*errno_fn)(void) = f[13];
  int (*close_range_fn)(unsigned int,unsigned int,int) = f[14];
  int (*prctl_fn)(int,unsigned long,unsigned long,unsigned long,unsigned long) = f[15];
  int so[2] = {-1,-1}, se[2] = {-1,-1}, setup[2] = {-1,-1};
  int life[2] = {-1,-1}, events[2] = {-1,-1}, started[2] = {-1,-1};
  int guardian, init, result, status = 0, nullfd;
  const int O_CLOEXEC = 02000000, O_RDONLY = 0, EINTR_VALUE = 4;
  const int WNOHANG_VALUE = 1, POLLIN_VALUE = 1, POLLHUP_VALUE = 16;
  const int CLOCK_MONOTONIC_VALUE = 1;
  char zero[] = "0", one[] = "1";

  if (pipe2_fn(so, O_CLOEXEC) || pipe2_fn(se, O_CLOEXEC) ||
      pipe2_fn(setup, O_CLOEXEC) || pipe2_fn(life, O_CLOEXEC) ||
      pipe2_fn(events, O_CLOEXEC) || pipe2_fn(started, O_CLOEXEC)) goto parent_failed;
  guardian = fork_fn();
  if (guardian < 0) goto parent_failed;
  if (!guardian) {
    struct timespec_local start, now;
    struct pollfd_local watch;
    struct event_local event;
    close_fn(so[0]); close_fn(se[0]); close_fn(setup[0]);
    close_fn(life[1]); close_fn(events[0]); close_fn(started[0]);
    if (unshare_fn(namespace_flags) < 0) {
      result = -*errno_fn(); write_fn(started[1], &result, sizeof(result)); exit_fn(125);
    }
    init = fork_fn();
    if (init < 0) {
      result = -*errno_fn(); write_fn(started[1], &result, sizeof(result)); exit_fn(125);
    }
    if (!init) {
      /* A separately killed guardian must not orphan the guest cgroup. */
      if (prctl_fn(1, 9, 0, 0, 0) < 0) exit_fn(125); /* PR_SET_PDEATHSIG, SIGKILL */
      /* CLONE_NEWNS is separated so the guardian retains the scratch mount. */
      if (unshare_fn(0x00020000) < 0) exit_fn(125);
      if (write_fn(cgroup_procs, zero, 1) != 1) exit_fn(125);
      nullfd = open_fn((char *)"/dev/null", O_RDONLY, 0);
      if (nullfd < 0 || dup2_fn(nullfd, 0) < 0 || dup2_fn(so[1], 1) < 0 ||
          dup2_fn(se[1], 2) < 0 || dup2_fn(setup[1], 3) < 0) exit_fn(125);
      /* The fresh worker marks fd 3 close-on-exec before the guest exec. */
      if (close_range_fn(4, ~0U, 0) < 0) exit_fn(125);
      exec_fn(executable, argv, env);
      { int failed[3]; failed[0] = 'F'; failed[1] = *errno_fn(); failed[2] = 0;
        write_fn(3, failed, sizeof(failed)); }
      exit_fn(127);
    }
    write_fn(started[1], &init, sizeof(init)); close_fn(started[1]);
    close_fn(so[1]); close_fn(se[1]); close_fn(setup[1]); close_fn(cgroup_procs);
    /* Do not retain the supervisor's lock, journal, or unrelated Bun fds. */
    for (int fd=3; fd<65536; fd++)
      if (fd != life[0] && fd != events[1] && fd != cgroup_kill) close_fn(fd);
    watch.fd = life[0]; watch.events = POLLIN_VALUE | POLLHUP_VALUE;
    clock_fn(CLOCK_MONOTONIC_VALUE, &start);
    for (;;) {
      result = wait_fn(init, &status, WNOHANG_VALUE);
      if (result == init) {
        write_fn(cgroup_kill, one, 1);
        event.kind = 'E'; event.value = status;
        write_fn(events[1], &event, sizeof(event)); exit_fn(0);
      }
      if (result < 0 && *errno_fn() != EINTR_VALUE) exit_fn(125);
      clock_fn(CLOCK_MONOTONIC_VALUE, &now);
      if (hard_deadline_ms > 0 && elapsed_ms(&start, &now) >= hard_deadline_ms) {
        event.kind = 'D'; event.value = 0;
        write_fn(events[1], &event, sizeof(event));
        write_fn(cgroup_kill, one, 1);
        do { result = wait_fn(init, &status, 0); } while (result < 0 && *errno_fn() == EINTR_VALUE);
        event.kind = 'E'; event.value = status;
        write_fn(events[1], &event, sizeof(event)); exit_fn(0);
      }
      result = poll_fn(&watch, 1, 20);
      if (result > 0 && (watch.revents & (POLLIN_VALUE | POLLHUP_VALUE))) {
        char command;
        result = read_fn(life[0], &command, 1);
        if (result == 1 && command == 'X') exit_fn(0);
        if (result <= 0) {
          write_fn(cgroup_kill, one, 1);
          do { result = wait_fn(init, &status, 0); } while (result < 0 && *errno_fn() == EINTR_VALUE);
          exit_fn(0);
        }
      }
    }
  }
  close_fn(so[1]); close_fn(se[1]); close_fn(setup[1]); close_fn(life[0]);
  close_fn(events[1]); close_fn(started[1]);
  result = -5;
  while (read_fn(started[0], &result, sizeof(result)) < 0 && *errno_fn() == EINTR_VALUE) {}
  close_fn(started[0]);
  if (result <= 1) {
    close_fn(so[0]); close_fn(se[0]); close_fn(setup[0]);
    close_fn(life[1]); close_fn(events[0]);
    return result;
  }
  out[0] = guardian; out[1] = result; out[2] = so[0]; out[3] = se[0];
  out[4] = setup[0]; out[5] = life[1]; out[6] = events[0];
  return 0;
parent_failed:
  result = -*errno_fn();
  { int *all[6] = {so,se,setup,life,events,started};
    for (int i=0; i<6; i++) for (int j=0; j<2; j++) if (all[i][j] >= 0) close_fn(all[i][j]); }
  return result;
}
