import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { MessageSquare, BarChart3, Tag, Users, ArrowRight, FileText } from 'lucide-react'
import useStore from '../store/useStore'
import StatCard from './StatCard'


function OverviewPanel() {
  const { meta, themes, entities, comments } = useStore()
  const navigate = useNavigate()
  const stats = meta?.stats || {
    totalComments: 0,
    condensedComments: 0,
    totalThemes: 0,
    totalEntities: 0,
    scoredComments: 0
  }

  // Calculate top themes
  const topThemes = useMemo(() => {
    return [...themes]
      .sort((a, b) => ((b.direct_count || 0) + (b.touch_count || 0)) - ((a.direct_count || 0) + (a.touch_count || 0)))
      .slice(0, 10)
  }, [themes])

  // Calculate entity stats
  const entityStats = useMemo(() => {
    let totalEntities = 0
    let totalMentions = 0
    Object.values(entities).forEach(category => {
      category.forEach(entity => {
        totalEntities++
        totalMentions += entity.mentionCount || 0
      })
    })
    return { totalEntities, totalMentions }
  }, [entities])

  // Calculate stakeholder breakdown - filter out types with < 5 comments
  const stakeholderBreakdown = useMemo(() => {
    const breakdown: Record<string, number> = {}
    comments.forEach(c => {
      const type = c.submitterType || 'Unknown'
      breakdown[type] = (breakdown[type] || 0) + 1
    })
    return Object.entries(breakdown)
      .filter(([, count]) => count >= 5) // Filter out types with < 5 comments
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
  }, [comments])
  
  // Get total count of stakeholder types with >= 5 comments
  const totalStakeholderTypes = useMemo(() => {
    const breakdown: Record<string, number> = {}
    comments.forEach(c => {
      const type = c.submitterType || 'Unknown'
      breakdown[type] = (breakdown[type] || 0) + 1
    })
    return Object.entries(breakdown).filter(([, count]) => count >= 5).length
  }, [comments])

  // Calculate clustering statistics
  const clusteringStats = useMemo(() => {
    const representatives = comments.filter(c => c.isClusterRepresentative)
    const hasClustering = representatives.length > 0
    const distinctComments = hasClustering ? representatives.length : stats.totalComments
    
    return {
      hasClustering,
      distinctComments,
      totalComments: stats.totalComments
    }
  }, [comments, stats.totalComments])

  return (
    <div className="space-y-6">
      {/* Summary Cards - All clickable */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Link to="/comments" className="block transform hover:scale-105 transition-transform">
          <StatCard
            icon={<MessageSquare className="h-6 w-6" />}
            label="Total Comments"
            value={stats.totalComments || 0}
            subtext={clusteringStats.hasClustering 
              ? `${clusteringStats.distinctComments.toLocaleString()} clusters`
              : `${stats.condensedComments || 0} analyzed`}
            color="blue"
            clickable
          />
        </Link>
        <Link to="/themes" className="block transform hover:scale-105 transition-transform">
          <StatCard
            icon={<BarChart3 className="h-6 w-6" />}
            label="Themes Identified"
            value={stats.totalThemes || 0}
            subtext={`${stats.scoredComments || 0} comments scored`}
            color="purple"
            clickable
          />
        </Link>
        <Link to="/entities" className="block transform hover:scale-105 transition-transform">
          <StatCard
            icon={<Tag className="h-6 w-6" />}
            label="Topics Mentioned"
            value={entityStats.totalEntities}
            subtext={`${entityStats.totalMentions.toLocaleString()} mentions`}
            color="green"
            clickable
          />
        </Link>
        <Link to="/comments?filter=stakeholder" className="block transform hover:scale-105 transition-transform">
          <StatCard
            icon={<Users className="h-6 w-6" />}
            label="Stakeholder Types"
            value={totalStakeholderTypes}
            subtext={`${stakeholderBreakdown[0]?.[0] || 'N/A'} most common`}
            color="orange"
            clickable
          />
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Themes */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Top Themes</h3>
          <div className="space-y-3">
            {topThemes.map(theme => (
              <div 
                key={theme.code} 
                className="flex items-center justify-between cursor-pointer hover:bg-gray-50 p-2 rounded-lg transition-colors"
                onClick={() => navigate(`/themes/${theme.code}`)}
              >
                <div className="flex-1">
                  <span className="font-medium text-gray-900">{theme.code}</span>
                  <span className="text-gray-600 ml-2">{theme.label || theme.description}</span>
                </div>
                <span className="text-sm text-blue-600 font-medium">
                  {theme.direct_count} comments
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Stakeholder Breakdown - All clickable */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="p-6 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">Stakeholder Breakdown</h2>
              <Link 
                to="/comments" 
                className="flex items-center space-x-1 text-sm text-blue-600 hover:text-blue-800"
              >
                <span>Browse all</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
          <div className="p-6 space-y-4">
            {stakeholderBreakdown.map(([type, count], index) => (
              <Link
                key={type}
                to={`/comments?submitterType=${encodeURIComponent(type)}`}
                className="flex items-center justify-between p-2 -m-2 rounded hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center space-x-3">
                  <span className="text-2xl font-bold text-gray-300">
                    {index + 1}
                  </span>
                  <span className="text-sm font-medium text-gray-900 hover:text-blue-600">{type}</span>
                </div>
                <div className="flex items-center space-x-3">
                  <div className="w-32 bg-gray-200 rounded-full h-2">
                    <div 
                      className="bg-green-600 h-2 rounded-full" 
                      style={{ width: `${(count / stats.totalComments) * 100}%` }}
                    />
                  </div>
                  <span className="text-sm text-gray-600 w-16 text-right">
                    {count.toLocaleString()}
                  </span>
                </div>
              </Link>
            ))}
            
            {totalStakeholderTypes > 5 && (
              <div className="mt-4 pt-2">
                <Link
                  to="/comments?filter=stakeholder"
                  className="text-sm text-blue-600 hover:text-blue-800 flex items-center space-x-1"
                >
                  <span>View all {totalStakeholderTypes} stakeholder types</span>
                  <ArrowRight className="h-3 w-3" />
                </Link>
              </div>
            )}
            
            {comments.length > 0 && (
              <div className="mt-6 pt-4 border-t border-gray-200">
                <Link
                  to="/comments?hasAttachments=true"
                  className="flex items-center justify-between text-sm p-2 -m-2 rounded hover:bg-gray-50 transition-colors"
                >
                  <span className="text-gray-500 hover:text-gray-700">Comments with attachments</span>
                  <span className="font-medium text-gray-900">
                    {comments.filter(c => c.hasAttachments).length.toLocaleString()}
                    <span className="text-gray-500 ml-1">
                      ({Math.round((comments.filter(c => c.hasAttachments).length / comments.length) * 100)}%)
                    </span>
                  </span>
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="bg-blue-50 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-blue-900 mb-4">Quick Actions</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Link
            to="/themes"
            className="flex items-center justify-between p-4 bg-white rounded-lg hover:shadow-md transition-shadow"
          >
            <div className="flex items-center space-x-3">
              <BarChart3 className="h-5 w-5 text-blue-600" />
              <span className="font-medium">Explore All Themes</span>
            </div>
            <ArrowRight className="h-4 w-4 text-gray-400" />
          </Link>
          
          <Link
            to="/summaries"
            className="flex items-center justify-between p-4 bg-white rounded-lg hover:shadow-md transition-shadow"
          >
            <div className="flex items-center space-x-3">
              <FileText className="h-5 w-5 text-purple-600" />
              <span className="font-medium">Theme Summaries</span>
            </div>
            <ArrowRight className="h-4 w-4 text-gray-400" />
          </Link>
          
          <Link
            to="/entities"
            className="flex items-center justify-between p-4 bg-white rounded-lg hover:shadow-md transition-shadow"
          >
            <div className="flex items-center space-x-3">
              <Tag className="h-5 w-5 text-green-600" />
              <span className="font-medium">Browse Topics</span>
            </div>
            <ArrowRight className="h-4 w-4 text-gray-400" />
          </Link>
          
          <Link
            to="/comments?hasCondensed=yes"
            className="flex items-center justify-between p-4 bg-white rounded-lg hover:shadow-md transition-shadow"
          >
            <div className="flex items-center space-x-3">
              <MessageSquare className="h-5 w-5 text-purple-600" />
              <span className="font-medium">Condensed Comments</span>
            </div>
            <ArrowRight className="h-4 w-4 text-gray-400" />
          </Link>
        </div>
      </div>
    </div>
  )
}

export default OverviewPanel 