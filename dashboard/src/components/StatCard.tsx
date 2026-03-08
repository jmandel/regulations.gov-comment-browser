import clsx from 'clsx'
import { ReactNode } from 'react'

const colorClasses = {
  blue: 'text-blue-600 bg-blue-50',
  purple: 'text-purple-600 bg-purple-50',
  green: 'text-green-600 bg-green-50',
  orange: 'text-orange-600 bg-orange-50',
  red: 'text-red-600 bg-red-50',
  gray: 'text-gray-600 bg-gray-50'
} as const

interface StatCardProps {
  icon: ReactNode
  label: string
  value: string | number
  subtext?: string
  color?: keyof typeof colorClasses
  clickable?: boolean
}

function StatCard({ icon, label, value, subtext, color = 'blue', clickable = false }: StatCardProps) {
  return (
    <div className={clsx(
      "bg-white rounded-lg shadow-sm border border-gray-200 p-4 sm:p-6",
      clickable && "cursor-pointer hover:shadow-lg hover:border-blue-300 transition-all"
    )}>
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-xs sm:text-sm text-gray-500">{label}</p>
          <p className="text-xl sm:text-2xl font-semibold text-gray-900 mt-1">
            {typeof value === 'number' ? value.toLocaleString() : value}
          </p>
          {subtext && (
            <p className="text-xs text-gray-400 mt-1 truncate">{subtext}</p>
          )}
        </div>
        <div className={clsx('p-2 sm:p-3 rounded-lg flex-shrink-0', colorClasses[color])}>
          {icon}
        </div>
      </div>
    </div>
  )
}

export default StatCard 