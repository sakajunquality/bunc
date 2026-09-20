/* Only libc calls run after fork; the child never resumes the JavaScript VM.
 * Function pointers avoid a dependency on development headers or linker files.
 * The intermediate process exits so containerd's subreaper adopts the init PID. */
typedef long ssize;
int bootstrap(void **f, int *namespaces, int count, int flags,
              char *executable, char **argv, char **env) {
  int (*pipe_fn)(int *) = f[0];
  int (*fork_fn)(void) = f[1];
  int (*close_fn)(int) = f[2];
  int (*setns_fn)(int,int) = f[3];
  int (*unshare_fn)(int) = f[4];
  ssize (*write_fn)(int,void *,unsigned long) = f[5];
  ssize (*read_fn)(int,void *,unsigned long) = f[6];
  int (*wait_fn)(int,int *,int) = f[7];
  int (*exec_fn)(char *,char **,char **) = f[8];
  void (*exit_fn)(int) = f[9];
  int *(*errno_fn)(void) = f[10];
  int (*close_range_fn)(unsigned int,unsigned int,int) = f[11];
  int p[2], pid, init, result, status;
  if (pipe_fn(p) < 0) return -*errno_fn();
  pid = fork_fn();
  if (pid < 0) { result = -*errno_fn(); close_fn(p[0]); close_fn(p[1]); return result; }
  if (!pid) {
    close_fn(p[0]);
    for (int i=0; i<count; i++) {
      if (setns_fn(namespaces[i], 0) < 0) goto failed;
    }
    if (unshare_fn(flags) < 0) goto failed;
    init = fork_fn();
    if (init < 0) goto failed;
    if (init) { write_fn(p[1], &init, sizeof(init)); exit_fn(0); }
    /* All non-stdio descriptors must disappear, including Bun's event loop. */
    if (close_range_fn(3, ~0U, 0) < 0) exit_fn(126);
    exec_fn(executable, argv, env);
    exit_fn(127);
failed:
    result = -*errno_fn(); write_fn(p[1], &result, sizeof(result)); exit_fn(1);
  }
  close_fn(p[1]);
  result = -5;
  while (read_fn(p[0], &result, sizeof(result)) < 0 && *errno_fn() == 4) {}
  close_fn(p[0]);
  while (wait_fn(pid, &status, 0) < 0 && *errno_fn() == 4) {}
  return result;
}
