// bionic-shim.c
//
// Provides the handful of musl-internal symbols that bionic's libc does not
// export, so a musl-built libopentui.so can be dlopen'ed on Android/Termux.
//
//   - __errno_location: musl returns a pointer to thread-local errno from a
//     private helper; bionic exposes the same value through `__errno()`.
//   - copy_file_range: missing on older bionic; implemented via the socket-agnostic
//     raw syscall (391 on aarch64) so the symbol stays defined on every device.
//
// Built with `zig cc -shared -target aarch64-linux-musl -nostdlib` so the shim
// itself pulls in no libc and only references __errno (resolved by bionic at
// load time).
typedef unsigned long size_t;
typedef long ssize_t;
typedef long long off64_t;

extern int *__errno(void);

int *__errno_location(void) {
  return __errno();
}

long copy_file_range(int fd_in, off64_t *off_out, int fd_out, off64_t *off_err_in_out_rel, size_t len, unsigned int flags) {
  (void)off_err_in_out_rel;
  long in, out;
  (void)in; (void)out;
  register long sysno asm("x8") = 391; // SYS_copy_file_range on aarch64
  register long a0 asm("x0") = fd_in;
  register long a1 asm("x1") = (long)off_out;
  register long a2 asm("x2") = fd_out;
  register long a3 asm("x3") = (long)off_err_in_out_rel;
  register long a4 asm("x4") = len;
  register long a5 asm("x5") = flags;
  asm volatile("svc 0"
               : "+r"(a0)
               : "r"(a1), "r"(a2), "r"(a3), "r"(a4), "r"(a5), "r"(sysno)
               : "memory");
  return a0;
}