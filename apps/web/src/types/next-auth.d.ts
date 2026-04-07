import 'next-auth'
import 'next-auth/jwt'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      username: string
      role: string
      email?: string | null
      name?: string | null
    }
  }

  interface User {
    username: string
    role: string
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    username: string
    role: string
  }
}
