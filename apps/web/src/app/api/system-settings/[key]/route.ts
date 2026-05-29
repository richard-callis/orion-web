import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(
  req: NextRequest,
  { params }: { params: { key: string } }
) {
  try {
    const setting = await prisma.systemSetting.findUnique({
      where: { key: params.key },
    })

    if (!setting) {
      return NextResponse.json(
        { error: 'Setting not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      key: setting.key,
      value: setting.value,
    })
  } catch (error) {
    console.error('Error getting system setting:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
